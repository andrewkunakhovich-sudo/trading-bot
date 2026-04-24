import WebSocket from 'ws';

const res = await fetch('http://localhost:9222/json');
const pages = await res.json();
const chart = pages.find(p => p.url && p.url.includes('tradingview.com/chart'));
const ws = new WebSocket(chart.webSocketDebuggerUrl);

ws.on('open', () => {
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
            expression: `
                // Find all buttons in the trading panel area
                const allBtns = [...document.querySelectorAll('button')];
                const tradingBtns = allBtns
                    .filter(b => b.textContent.trim().length > 0)
                    .map(b => b.textContent.trim().substring(0, 50) + ' | class: ' + b.className.substring(0, 60))
                    .filter(t => t.match(/buy|sell|order|trade|paper|position|market/i))
                    .slice(0, 20);
                JSON.stringify(tradingBtns);
            `
        }
    }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id === 1) {
        console.log('Trading buttons found:');
        const btns = JSON.parse(msg.result.result.value || '[]');
        btns.forEach(b => console.log(' -', b));
        ws.close();
        process.exit(0);
    }
});
