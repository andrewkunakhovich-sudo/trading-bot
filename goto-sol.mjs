import WebSocket from 'ws';

const res = await fetch('http://localhost:9222/json');
const pages = await res.json();
const chart = pages.find(p => p.url && p.url.includes('tradingview.com/chart'));
const ws = new WebSocket(chart.webSocketDebuggerUrl);

ws.on('open', () => {
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: `window.location.href = 'https://www.tradingview.com/chart/?symbol=KRAKEN:SOLUSD&interval=1';` }
    }));
    setTimeout(() => { ws.close(); process.exit(0); }, 1500);
});
