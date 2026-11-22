// What `relaylead overview --json` gives (core/overview.js), and the state the mod keeps from it.
export type RelayleadWindow = { percent: number; resetsAt: string | null };

export type RelayleadQuestion = {
  id: string;
  text: string;
  context: string | null;
  options: string[];
  recommended: number | null;
  askedAt: string;
};

export type RelayleadTask = { id: string; title: string; state: string };

export type RelayleadMission = {
  name: string;
  dir: string;
  priority: string;
  state: string;
  active: boolean;
  pausedUntil: string | null;
  tasks: RelayleadTask[];
  questions: RelayleadQuestion[];
};

export type RelayleadOverview = {
  language: string;
  display: { pane: string | null; statusLine: boolean; dashboardPort: number };
  usage: { at: string; fiveHour: RelayleadWindow | null; sevenDay: RelayleadWindow | null } | null;
  missions: RelayleadMission[];
  activeMissions: number;
  openQuestions: number;
};

declare module 'claude-code' {
  interface PluginState {
    relaylead: {
      // The last overview read; null until the first one.
      overview: Shaped<RelayleadOverview | null>;
      // Whether the bar "Always / This time / Never" is shown above the prompt.
      proposal: boolean;
    };
  }
}
