import WebSocket from 'ws';
import { readFileSync } from 'fs';

// Load executed trades only
const trades = JSON.parse(readFileSync('trades-data.json', 'utf8'))
  .filter(t => t.orderPlaced);

console.log(`Plotting ${trades.length} executed trades on TradingView...`);

const res = await fetch('http://localhost:9222/json');
const pages = await res.json();
const chart = pages.find(p => p.url && p.url.includes('tradingview.com/chart'));
if (!chart) { console.log('TradingView not found — make sure it is open.'); process.exit(1); }

const ws = new WebSocket(chart.webSocketDebuggerUrl);

ws.on('open', () => {
    // Use TradingView's internal chart API to create arrow markers
    const script = `
    (function() {
        // Get the active chart widget
        const iframe = document.querySelector('iframe[id*="tradingview"]') || document;
        const win = iframe.contentWindow || window;

        // Try to access TradingView's chart API
        const tvWidget = win.tvWidget || window.tvWidget;
        const chart = tvWidget?.activeChart?.() || win._tvWidget?.activeChart?.();

        if (!chart) {
            // Fallback: use createShape via the global TradingView object
            const trades = ${JSON.stringify(trades.map(t => ({
                time: Math.floor(new Date(t.timestamp).getTime() / 1000),
                price: t.price,
                symbol: t.symbol,
                side: t.allPass ? 'buy' : 'sell'
            })))};

            // Draw using TradingView's drawing API if available
            if (window.Datafeeds || window.TradingView) {
                return 'TV API found but chart object not directly accessible';
            }
            return 'Chart API not accessible — try adding shapes manually';
        }

        const trades = ${JSON.stringify(trades)};
        trades.forEach(t => {
            const time = Math.floor(new Date(t.timestamp).getTime() / 1000);
            chart.createShape(
                { time, price: t.price },
                { shape: 'arrow_up', text: 'BOT BUY', overrides: { color: '#00ff88', textColor: '#00ff88', fontsize: 12 } }
            );
        });
        return 'Arrows plotted: ' + trades.length;
    })();
    `;

    ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: script }
    }));
});

ws.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.id === 1) {
        const result = msg.result?.result?.value || msg.result?.result?.description;
        console.log('Result:', result);

        if (result && result.includes('not accessible')) {
            console.log('\nTrying alternative approach via TradingView URL with study...');
            // Alternative: navigate to chart with the trade timestamp highlighted
            const firstTrade = trades[0];
            if (firstTrade) {
                const time = Math.floor(new Date(firstTrade.timestamp).getTime() / 1000);
                ws.send(JSON.stringify({
                    id: 2,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: `
                        // Scroll chart to the time of the first trade
                        const time = ${time};
                        const tv = window.tvWidget || Object.values(window).find(v => v?.activeChart);
                        if (tv?.activeChart) {
                            tv.activeChart().setVisibleRange({ from: time - 3600, to: time + 3600 });
                            'Scrolled to trade time';
                        } else { 'Widget not found'; }
                        `
                    }
                }));
            }
        }
        ws.close();
        process.exit(0);
    }
});
