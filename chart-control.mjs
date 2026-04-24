import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:9222/devtools/page/BD7EA5B423A90454CDCD04E803E737C7');

ws.on('open', () => {
    // Switch to BTCUSD 1-minute chart
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
            expression: `window.location.href = 'https://www.tradingview.com/chart/8TdTV9Lo/?symbol=BITSTAMP%3ABTCUSD&interval=1';`
        }
    }));
    setTimeout(() => { ws.close(); process.exit(0); }, 2000);
});
