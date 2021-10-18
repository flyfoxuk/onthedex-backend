/**
 * @module getArgs.js
 * get command line arguments (commands, named arguments, flags)
 *
 * @see https://stackoverflow.com/a/54098693/1786393
 *
 * @return {Object}
 *
 */
function getArgs () {
  const commands = []
  const args = {}
  process.argv
    .slice(2, process.argv.length)
    .forEach( arg => {
      // long arg
      if (arg.slice(0,2) === '--') {
        const longArg = arg.split('=')
        const longArgFlag = longArg[0].slice(2,longArg[0].length)
        const longArgValue = longArg.length > 1 ? longArg[1] : true
        args[longArgFlag] = longArgValue
     }
     // flags
      else if (arg[0] === '-') {
        const flags = arg.slice(1,arg.length).split('')
        flags.forEach(flag => {
          args[flag] = true
        })
      }
     else {
      // commands
      commands.push(arg)
     } 
    })
  return { args, commands }
}


// test
if (require.main === module) {
  // node getArgs test --dir=examples/getUserName --start=getUserName.askName
  console.log( getArgs() )
}

module.exports = { getArgs }