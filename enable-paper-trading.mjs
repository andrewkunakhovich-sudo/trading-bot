import WebSocket from 'ws';

const res = await fetch('http://localhost:9222/json');
const pages = await res.json();
const chart = pages.find(p => p.url && p.url.includes('tradingview.com/chart'));
const ws = new WebSocket(chart.webSocketDebuggerUrl);

ws.on('open', () => {
    // Click the Trading Panel button at the bottom of TradingView
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
            expression: `
                // Find and click the Paper Trading / Trading Panel button
                const btns = [...document.querySelectorAll('button, [class*="trading"], [class*="paper"]')];
                const tradingBtn = btns.find(b => b.textContent.includes('Trading Panel') || b.textContent.includes('Paper Trading') || b.getAttribute('data-name') === 'trading-panel-button');
                if (tradingBtn) { tradingBtn.click(); 'clicked'; } else { 'not found'; }
            `
        }
    }));
    setTimeout(() => { ws.close(); process.exit(0); }, 2000);
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.result) console.log('Result:', JSON.stringify(msg.result));
});
