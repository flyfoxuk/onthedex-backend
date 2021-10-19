![OnTheDex Logo](https://preview-beta.onthedex.live/onthedex_logo_simple.svg)

# OnTheDEX.live Backend
### BETA, POC
Initial Proof-Of-Concept Prototype (BETA) of node backend for OnTheDex.live project


### THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


### Preview website
Demo front-end that uses data provided by this backend is available at:

https://preview-beta.onthedex.live

> **Please note:** This is a BETA proof-of-concept product that is not optimised for scale.  It is **bandwidth intensive** on the server.  Please be aware that sharing this preview build web link with others more widely will have an impact on the charges I incur.  Please do not share this preview build link widely, yet.

### Install
- Clone the project.
- If desired for websocket functionality, ensure ws.cer, ws.key and ws.ca (if necessary) are present in root folder.  If so, secure websocket server will start as part of the backend and you can connect to it as desired (see code).

    Option: to run locally with SSL:
     - generate LetsEncrypt cert and key for ws.abc.com
     - make entry in /etc/hosts for ws.abc.com to point to 127.0.0.1
     - place .cer and .key files into repo root named as ws.cer and ws.key
     - after starting, WS endpoints available on wss://SSL_domain_here

    Option: to run locally unsecured:
     - delete any ws.cer and ws.key files in repo root.  Project will start with websocket data available on ws://127.0.0.1
        
- Install dependencies:
    `npm i`

- To start:
    `node main.js` to start with websocket running on port 443 (default), or

    `node main.js --port=8586` to start with websocket on your chosen port

- Websocket endpoints available at:

    `/token-volume`

    `/token-list`
