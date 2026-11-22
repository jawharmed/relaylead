import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RelayleadMission, RelayleadOverview, RelayleadWindow } from '../types'

const PANE = 'relaylead'
const EVERY_MS = 5000

// Change the tag when the overview changes shape: it declines what an earlier version stored.
const overview = atom({ plugin: 'relaylead', key: 'overview' } as const, null, { shape: 'overview-1' })
const proposal = atom({ plugin: 'relaylead', key: 'proposal' } as const, false)

const TEXT = {
  en: {
    missions: (n: number) => `${n} mission${n === 1 ? '' : 's'}`,
    quota: 'quota',
    fiveHour: '5 h',
    sevenDay: '7 d',
    none: 'No mission running.',
    finished: 'Finished',
    paused: 'paused',
    tasks: 'tasks',
    waiting: 'waiting for you',
    recommended: 'recommended',
    ask: 'Show the Relaylead panel next to the conversation?',
    always: 'Always',
    once: 'This time',
    never: 'Never',
    opened: 'Relaylead panel opened.',
    closed: 'Relaylead panel closed.',
    placed: 'The panel opens once the terminal is wide enough.',
    unreachable: 'The relaylead command did not answer.',
  },
  fr: {
    missions: (n: number) => `${n} mission${n === 1 ? '' : 's'}`,
    quota: 'quota',
    fiveHour: '5 h',
    sevenDay: '7 j',
    none: 'Aucune mission en cours.',
    finished: 'Terminées',
    paused: 'en pause',
    tasks: 'tâches',
    waiting: 'vous attend',
    recommended: 'recommandée',
    ask: 'Afficher le panneau Relaylead à côté de la conversation ?',
    always: 'Toujours',
    once: 'Cette fois',
    never: 'Jamais',
    opened: 'Panneau Relaylead ouvert.',
    closed: 'Panneau Relaylead fermé.',
    placed: 'Le panneau s’ouvrira dès que le terminal sera assez large.',
    unreachable: 'La commande relaylead n’a pas répondu.',
  },
}
const words = (language?: string) => (language === 'fr' ? TEXT.fr : TEXT.en)

// The window of the usage the person is closest to the limit of.
function busiestWindow(data: RelayleadOverview, w: ReturnType<typeof words>) {
  const windows: [string, RelayleadWindow | null | undefined][] = [
    [w.fiveHour, data.usage?.fiveHour],
    [w.sevenDay, data.usage?.sevenDay],
  ]
  const known = windows.filter((pair): pair is [string, RelayleadWindow] => pair[1] != null)
  if (known.length === 0) return null
  return known.reduce((best, pair) => (pair[1].percent > best[1].percent ? pair : best))
}

// `relaylead · 2 missions · ❓1 · quota 62 %`: only the parts there is something to say about.
function statusText(data: RelayleadOverview) {
  const w = words(data.language)
  const parts = ['relaylead']
  if (data.activeMissions > 0) parts.push(w.missions(data.activeMissions))
  if (data.openQuestions > 0) parts.push(`❓${data.openQuestions}`)
  const busiest = busiestWindow(data, w)
  if (busiest) parts.push(`${w.quota} ${busiest[0]} ${Math.round(busiest[1].percent)} %`)
  return parts.join(' · ')
}

function bar(percent: number, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const stateColor = (mission: RelayleadMission) =>
  mission.pausedUntil || mission.state.startsWith('waiting') ? 'warning' : mission.state.startsWith('stopped') ? 'error' : 'success'

const taskMark: Record<string, [string, string]> = {
  running: ['●', 'success'],
  queued: ['◌', 'warning'],
  done: ['●', 'suggestion'],
  delivered: ['✓', 'suggestion'],
  failed: ['✗', 'error'],
  todo: ['○', 'inactive'],
}

// Once per session: the question of the first mission, and the automatic opening of the pane.
let hasProposed = false
let hasOpened = false

// Reads the overview through the CLI, then draws the status line and, when asked, the pane.
async function refresh($: any) {
  let data: RelayleadOverview
  try {
    const ran = await $.process.run(['relaylead', 'overview', '--json'], { timeoutMs: 15000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr)
    data = JSON.parse(ran.stdout)
  } catch {
    $.ui.status(undefined)
    return
  }
  await update($, overview, () => data)

  const isBusy = data.activeMissions > 0 || data.openQuestions > 0
  $.ui.status(isBusy && data.display.statusLine !== false ? statusText(data) : undefined)

  if (data.activeMissions > 0 && !hasProposed && !hasOpened) {
    if (data.display.pane === 'always') {
      hasOpened = true
      void $.ui.open({ id: PANE, title: 'Relaylead' })
    } else if (data.display.pane == null) {
      hasProposed = true
      await update($, proposal, () => true)
    }
  }
}

async function choose($: any, choice: 'always' | 'once' | 'never') {
  await update($, proposal, () => false)
  if (choice === 'never') {
    await $.process.run(['relaylead', 'config', 'set', 'display.pane', 'never'])
    return
  }
  if (choice === 'always') await $.process.run(['relaylead', 'config', 'set', 'display.pane', 'always'])
  hasOpened = true
  await $.ui.open({ id: PANE, title: 'Relaylead' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panneau', description: 'Open or close the Relaylead panel (missions, tasks, questions)' })
    void refresh($)
    $.clock.every(EVERY_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'panneau' }, async $ => {
    const w = words((await read($, overview))?.language)
    if ((await $.ui.panes()).some((pane: { id: string }) => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: w.closed }
    }
    hasOpened = true
    const opened = await $.ui.open({ id: PANE, title: 'Relaylead' })
    void refresh($)

    return { text: opened.isPlaced ? w.opened : w.placed }
  })

  // The question of the first mission: a row above the prompt with three buttons.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isAsked = await read($, proposal)
    if (!isAsked || e.props.hasSurvey) return next(e)

    const w = words((await read($, overview))?.language)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={1}>
        <Text>{w.ask}</Text>
        <Button key="always" label={w.always} onPress={() => choose($, 'always')} />
        <Button key="once" label={w.once} onPress={() => choose($, 'once')} />
        <Button key="never" label={w.never} onPress={() => choose($, 'never')} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const data = await read($, overview)
    const w = words(data?.language)

    if (!data || data.missions.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{w.none}</Text>
        </Box>
      )
    }

    const active = data.missions.filter(mission => mission.active).sort((a, b) => b.questions.length - a.questions.length)
    const finished = data.missions.filter(mission => !mission.active)
    const busiest = busiestWindow(data, w)

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Relaylead · {w.missions(data.activeMissions)}
            {data.openQuestions > 0 ? ` · ❓${data.openQuestions}` : ''}
          </Text>
          {data.usage?.fiveHour && (
            <Text dimColor>
              {w.fiveHour} {bar(data.usage.fiveHour.percent)} {Math.round(data.usage.fiveHour.percent)} %
            </Text>
          )}
          {data.usage?.sevenDay && (
            <Text dimColor>
              {w.sevenDay} {bar(data.usage.sevenDay.percent)} {Math.round(data.usage.sevenDay.percent)} %
            </Text>
          )}
          {!data.usage && busiest === null && <Text dimColor>{w.quota} ?</Text>}
        </Box>

        {active.map(mission => {
          const delivered = mission.tasks.filter(task => task.state === 'delivered').length
          return (
            <Box key={mission.name} flexDirection="column" borderStyle="round" borderColor={mission.questions.length > 0 ? 'warning' : 'promptBorder'} paddingX={1}>
              <Box gap={1}>
                <Text bold>{mission.name}</Text>
                <Text color={stateColor(mission)}>{mission.pausedUntil ? w.paused : mission.state}</Text>
                {mission.priority !== 'normal' && <Text dimColor>{mission.priority}</Text>}
                {mission.tasks.length > 0 && (
                  <Text dimColor>
                    {delivered}/{mission.tasks.length} {w.tasks}
                  </Text>
                )}
              </Box>

              {mission.questions.map(question => (
                <Box key={question.id} flexDirection="column" marginY={1}>
                  <Text color="warning" bold>
                    ❓ {question.text}
                  </Text>
                  {question.context && <Text dimColor>{question.context}</Text>}
                  <Box gap={1} flexWrap="wrap">
                    {question.options.map((option, index) => (
                      <Button
                        key={`${mission.name}-${question.id}-${index}`}
                        label={index + 1 === question.recommended ? `${option} ★` : option}
                        onPress={async () => {
                          await $.process.run(['relaylead', 'answer', mission.name, question.id, String(index + 1)])
                          await refresh($)
                        }}
                      />
                    ))}
                  </Box>
                </Box>
              ))}

              {mission.tasks.map(task => {
                const [mark, color] = taskMark[task.state] ?? ['○', 'inactive']
                return (
                  <Text key={task.id}>
                    <Text color={color}>{mark}</Text> {task.title} <Text dimColor>{task.state}</Text>
                  </Text>
                )
              })}
            </Box>
          )
        })}

        {finished.length > 0 && (
          <Text dimColor>
            {w.finished}: {finished.map(mission => mission.name).join(', ')}
          </Text>
        )}
      </Box>
    )
  })
}
