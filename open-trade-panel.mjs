import WebSocket from 'ws';

const res = await fetch('http://localhost:9222/json');
const pages = await res.json();
const chart = pages.find(p => p.url && p.url.includes('tradingview.com/chart'));
const ws = new WebSocket(chart.webSocketDebuggerUrl);

ws.on('open', () => {
    // Click the Trade button to open the trading panel
    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
            expression: `
                const btns = [...document.querySelectorAll('button')];
                const tradeBtn = btns.find(b => b.textContent.trim() === 'Trade');
                if (tradeBtn) { tradeBtn.click(); 'clicked Trade button'; }
                else { 'Trade button not found'; }
            `
        }
    }));
});

ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.id === 1) {
        console.log('Step 1:', msg.result.result.value);

        // Wait for panel to open then inspect it
        await new Promise(r => setTimeout(r, 2000));

        ws.send(JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
                expression: `
                    const btns = [...document.querySelectorAll('button')];
                    const relevant = btns
                        .filter(b => b.textContent.trim().length > 0)
                        .map(b => b.textContent.trim().substring(0, 60))
                        .filter(t => t.match(/buy|sell|paper|market|limit|qty|amount|size/i))
                        .slice(0, 20);
                    JSON.stringify(relevant);
                `
            }
        }));
    }
    if (msg.id === 2) {
        console.log('Panel buttons:', msg.result.result.value);
        ws.close();
        process.exit(0);
    }
});
