// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!

/*
    This process is forked from the main backend to get 24-hours worth of price oracle data from the rXumm account (passed to it by calling process).
    Used on first startup with no price oracle data history (eg. first run)
*/



const fs = require('fs');
const { XrplClient } = require("xrpl-client");
const { getArgs } = require('./helpers/arguments.js')
const { rippleToUnixTimestamp, findLedgerIndexForDate, findPriceOracleBetweenLedgersAsync } = require('./helpers/xrpl-helpers.js')


// global xrpl client connection
let client

// global stack of issuers to get 24-hour order data for
let stackOfIssuers = []



const processPriceOracle = () => {
    
    // get the 0 index item at the top of the stack
    const issuerEntry = stackOfIssuers[0]

    return new Promise((resolve, reject) => {

        // get starting ledger
        client.send({
            command: 'ledger',
            ledger_index: issuerEntry.ledger_max,
            full: false,
            accounts: false,
            transactions: false,
            expand: false,
            owner_funds: false
        }).then(ledger_request => {
            // put into useful vars
            const startingLedgerObj = {
                ledger_index: ledger_request.ledger_index,
                close_time: ledger_request.ledger.close_time,
                close_time_unix: rippleToUnixTimestamp(ledger_request.ledger.close_time),
            }

            // now find the 24-hrs ago ledger from this ledger
            findLedgerIndexForDate(client, startingLedgerObj.close_time_unix - (24*60*60*1000), startingLedgerObj).then(targetLedgerBack => {

                // set the ledger min/max parameters for getting the 24hr block of trades
                const paramsForGetter = {
                    ledgerMin: targetLedgerBack.target_ledger_index,
                    ledgerMax: startingLedgerObj.ledger_index,
                    issuer: issuerEntry.issuer
                }

                // start getting the price data now
                findPriceOracleBetweenLedgersAsync(client, paramsForGetter).then(all_po => {
                    
                    // save it
                    // fs.writeFileSync('./PO24_'+issuerEntry.issuer+'.json', JSON.stringify(all_po, null, 2))

                    // pass it back to the parent
                    console.log('Sending price data to parent...')
                    const sendResult = process.send({
                        price_oracle: all_po
                    })
                    console.log('Sent to parent, result is ', sendResult)
                    
                    // unshift from stack (only ever 1 entry but for now keep this incase of future expansion)
                    stackOfIssuers.shift()
                    processingIssuer = false

                    resolve()

                }).catch(err => {
                    console.error('ERROR with ', err)
                    reject()
                })
            })
        }).catch(err => {
            console.error('PRICE ORACLE ERROR', err)
            reject()
        })
    })
}





const main = async() => {

    const cmd_line_arguments = getArgs()
    console.dir(cmd_line_arguments)

    console.log('INITIALIZING GETTER CLIENT....')
    client = new XrplClient(['wss://s1.ripple.com']);


    client.on("retry", (a) => {
        console.log("retry", a);
    });

    client.on("close", (a) => {
        console.log("close", a);
        // mark it as not processing anymore
        processingIssuer = false
    });

    client.on("state", (a) => {
        console.log("state", a);
    });

    client.on("nodeswitch", (a) => {
        console.log("nodeswitch", a)
    });
    client.on("online", (a) => {
        console.log("online", a)
        processingIssuer = false
    });
    client.on("offline", (a) => {
        console.log("offline", a)
    });
    client.on("round", (a) => {
        console.log("round", a)
    });
    client.on("reconnect", (a) => {
        console.log("reconnect", a)
    });
    

    console.log('calling await client.ready()')
    await client.ready();
    console.log('GETTER CLIENT READY.....')


    // for DEBUG
    setInterval(() => {
        console.log('GETTER TICKER - ', client.getState())
    }, 5000)


    // push onto stack (we only use 1 item in the array but for now keep as array incase of future expansion)
    stackOfIssuers.push({
        issuer: cmd_line_arguments.args['issuer'],
        ledger_max: cmd_line_arguments.args['ledger-max']
    })

    // start getting the data
    processPriceOracle().then(() => {
        console.log('resolved, setting exit timer...')
        setInterval(() => {
            console.log('destroying connection...')
            client.destroy();
            console.log('getter done, over and out, exiting here')
            process.exit();

        }, 4000)
    }).catch(err => {
        console.error('CAUGHT processPriceOracle ERROR:', err)
        process.exit();
    });

}



main()