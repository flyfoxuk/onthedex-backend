// THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!



const fs = require('fs');
const path = require('path');



// const PORT = 443;  not used any more, instead specify on cmdline with --port option if 443 not desired/in use already
const sslfile_cert = path.join(__dirname, '../ws.cer')
const sslfile_key = path.join(__dirname, '../ws.key')
const sslfile_ca = path.join(__dirname, '../ws.ca')     // if required, set to null if not required


const connectedClientsByRoute = {}

// do we want an SSL websocket?  Detect files and setup if present, otherwise run unsecured locally
const fastifyOptions = { 
    logger: true,
}

if (sslfile_cert && fs.existsSync(sslfile_cert)) {
    fastifyOptions.https = {
        cert: sslfile_cert && fs.existsSync(sslfile_cert) ? fs.readFileSync(sslfile_cert) : undefined,
        key: sslfile_key && fs.existsSync(sslfile_key) ? fs.readFileSync(sslfile_key) : undefined,
        ca: sslfile_ca && fs.existsSync(sslfile_ca) ? fs.readFileSync(sslfile_ca) : undefined,
    }
}

// instantiate the fastify instance
const fastify = require('fastify')(fastifyOptions)
fastify.register(require('fastify-websocket'))





const initWebsocketServer = async(port, sendOnConnectFns) => {


    fastify.get('/test', (req, reply) => {
        reply.send({ hello: 'world',  timeNow: Date()})
    })

    
    fastify.get('/token-volume', { websocket: true }, (connection /* SocketStream */, req /* FastifyRequest */) => {
        const routePath = '/token-volume'
        const socketID = req.headers['sec-websocket-key']
        if (!connectedClientsByRoute[routePath]) connectedClientsByRoute[routePath] = {}
        connectedClientsByRoute[routePath][socketID] = connection;

        fastify.log.info({
            msg: 'Client connected',
            socket: socketID
        })


        if (typeof sendOnConnectFns[routePath] == 'function') {
            sendOnConnectFns[routePath]()
        }

        connection.socket.on('message', message => {
            fastify.log.info({
                msg: 'Message recvd: ' + message,
                socket: socketID
            })
            // console.log(connection.socket)
        })


        connection.socket.on('close', () => {
            delete connectedClientsByRoute[routePath][socketID]
            fastify.log.info({
                msg: 'Client disconnected',
                socket: socketID
            })
        })
    })


    fastify.get('/token-list', { websocket: true }, (connection /* SocketStream */, req /* FastifyRequest */) => {
        const routePath = '/token-list'
        const socketID = req.headers['sec-websocket-key']
        if (!connectedClientsByRoute[routePath]) connectedClientsByRoute[routePath] = {}
        connectedClientsByRoute[routePath][socketID] = connection;

        fastify.log.info({
            msg: 'Client connected',
            socket: socketID
        })


        if (typeof sendOnConnectFns[routePath] == 'function') {
            sendOnConnectFns[routePath]()
        }

        connection.socket.on('message', message => {
            fastify.log.info({
                msg: 'Message recvd: ' + message,
                socket: socketID
            })
            // console.log(connection.socket)
        })


        connection.socket.on('close', () => {
            delete connectedClientsByRoute[routePath][socketID]
            fastify.log.info({
                msg: 'Client disconnected',
                socket: socketID
            })
        })
    })

    fastify.listen(port, '0.0.0.0', err => {
        if (err) {
            fastify.log.error(err)
            process.exit(1)
        }
    })
    //console.log('fastify ws listening')

    if (!sslfile_cert || !fs.existsSync(sslfile_cert)) {
        console.log('NOTE: SSL for websocket not found or not specified, websocket established without SSL (may not work correctly)...')
    }

}






const sendWebsocketData = async(path, data) => {
    const connectionsInPath = Object.values(connectedClientsByRoute[path] || [])
    console.log('connectionsInPath ', path, connectionsInPath.length)
    if (connectionsInPath.length > 0) {
        const dataToSendAsJSON = JSON.stringify(data)
        connectionsInPath.forEach(client => {
            if (client.socket.readyState == 1) {
                client.socket.send(dataToSendAsJSON)
            }
        })
    }

}





module.exports = {
    initWebsocketServer,
    sendWebsocketData,
}
