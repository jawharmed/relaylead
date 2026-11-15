// Hook StopFailure : garde l'entrée reçue dans RL_OUT/stopfailure.json.
const { readStdinJson, writeJson, out } = require('./lib');
readStdinJson().then((j) => writeJson(out('stopfailure.json'), { at: new Date().toISOString(), input: j }));
