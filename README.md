# OnTheDEX.live backend

## Prototype (ALPHA) of node backend for OnTheDex.live project
### THIS IS BETA SOFTWARE, PROOF-OF-CONCEPT, and UN-OPTIMISED!


### Install
- Clone the project.
- If desired for websocket functionality, ensure ws.cer, ws.key and ws.ca (if necessary) are present in root folder.  If so, secure websocket server will start as part of the backend and you can connect to it as desired (see code).

    Option: to run locally with SSL:
     - generate LetsEncrypt cert and key for ws.abc.com
     - make entry in /etc/hosts for ws.abc.com to point to 127.0.0.1
     - place .cer and .key files into repo root named as ws.cer and ws.key

    Option: to run locally unsecured:
     - delete any ws.cer and ws.key files in repo root.  Project will start with websocket data available on ws://127.0.0.1/
        
- Install dependencies:
    `npm i`

- To start:
    `node main.js`

- Websocket endpoints available at:

    `/token-volume`

    `/token-list`
