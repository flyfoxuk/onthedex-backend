// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


// fork procs

const fork = require('child_process').fork;

const setupFork = ({program, onMessageFn, parameters = [], onExitFn}) => {

    // const parameters = [];
    const options = {
        stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ]
    };
    const child = fork(program, parameters, options);

    child.on('message', (msg) => {
        // console.log('---------- MSG FROM CHILD:', msg)
        onMessageFn(msg)
    });

    child.stdout.on('data', (data) => {
        console.log(`-----------CHILD CONSOLE: ${data}`);
    });

    child.stderr.on('data', (data) => {
        console.error(`-----------CHILD ERROR: ${data}`);
    });

    child.on('close', (code) => {
        console.log(`-----------child process exited with code ${code}`);
    });

    if (typeof onExitFn == 'function') child.on('exit', onExitFn)
    return child;
}



module.exports = {
    setupFork
}