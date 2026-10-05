import path from 'path';
import express, { Request, Response } from 'express';
import turnstile from './lib/ends/turnstile';
import iuam from './lib/ends/iuam';
import { connect } from "./lib/browser/br";

const MAX_LOGS = 300;
interface LogEntry {
    time: string;
    level: 'info' | 'warn' | 'error';
    message: string;
}
const logBuffer: LogEntry[] = [];

function appendLog(level: 'info' | 'warn' | 'error', args: any[]) {
    try {
        const message = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
        }).join(' ');

        logBuffer.push({
            time: new Date().toLocaleTimeString(),
            level,
            message
        });
        if (logBuffer.length > MAX_LOGS) {
            logBuffer.shift();
        }
    } catch { }
}

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
    origLog(...args);
    appendLog('info', args);
};
console.warn = (...args) => {
    origWarn(...args);
    appendLog('warn', args);
};
console.error = (...args) => {
    origError(...args);
    appendLog('error', args);
};

const app = express();
const port = process.env.PORT || 8742;
const authToken = process.env.authToken || null;

(global as any).browserLimit = Number(process.env.browserLimit) || 20;
(global as any).timeOut = Number(process.env.timeOut) || 60000;

const CACHE_TTL = 30 * 60 * 1000;

interface CacheEntry {
    expireAt: number;
    value: any;
}

interface Cache {
    [key: string]: CacheEntry;
}

const memoryCache: Cache = {};

async function readCache(key: string): Promise<any> {
    const entry = memoryCache[key];
    if (entry && Date.now() < entry.expireAt) {
        return entry.value;
    }
    return null;
}

async function writeCache(key: string, value: any, ttl: number = CACHE_TTL) {
    memoryCache[key] = { expireAt: Date.now() + ttl, value };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'development') {
    let server = app.listen(port, async () => {
        console.log(`Server running on port ${port}`);
    });
    try {
        server.timeout = (global as any).timeOut;
    } catch { }
}

let browser: any = null;

async function initBrowser() {
    if (browser) return browser;

    try {
        const { browser: connectedBrowser } = await connect({
            headless: false,
            turnstile: true,
            connectOption: { defaultViewport: null },
            disableXvfb: false,
        });

        browser = connectedBrowser;

        browser.on('disconnected', () => {
            console.log('Browser disconnected');
            browser = null;
        });

        return browser;
    } catch (error) {
        console.error('Failed to initialize browser:', error);
        throw error;
    }
}

initBrowser().then(() => console.log("Browser initialized")).catch(err => console.error("Initial browser launch failed", err));


async function getPage() {
    if (!browser || !browser.isConnected()) {
        await initBrowser();
    }

    if (!browser) {
        throw new Error("Browser not available");
    }

    const page = await browser.newPage();

    await page.goto('about:blank');
    await page.setRequestInterception(true);
    page.on('request', async (req: any) => {
        const type = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(type)) {
            await req.abort();
        } else {
            await req.continue();
        }
    });

    return page;
}

interface EventLog {
    ts: number;
    endpoint: string;
    status: number;
    duration: number;
    summary: string;
}

const stats = {
    solved: 0,
    challenges: 0,
    errors: 0,
    in_flight: 0,
    durations: [] as number[],
    events: [] as EventLog[]
};

function recordEvent(endpoint: string, status: number, durationSec: number, summary: string) {
    if (status >= 200 && status < 400) {
        if (summary.toLowerCase().includes('turnstile')) {
            stats.solved++;
        } else {
            stats.challenges++;
        }
    } else {
        stats.errors++;
    }
    stats.durations.push(durationSec * 1000);
    if (stats.durations.length > 200) stats.durations.shift();

    stats.events.unshift({
        ts: Math.floor(Date.now() / 1000),
        endpoint,
        status,
        duration: durationSec,
        summary
    });
    if (stats.events.length > 50) stats.events.pop();
}

const handleCloudflare = async (req: Request, res: Response): Promise<any> => {
    const startTime = Date.now();
    const data = req.body;
    if (!data || typeof data.mode !== 'string') {
        const errRes = { success: false, code: 400, message: 'Bad Request: missing or invalid mode' };
        recordEvent(req.path || '/cloudflare', 400, (Date.now() - startTime) / 1000, 'Bad Request: missing mode');
        return res.status(400).json(errRes);
    }
    if (authToken && data.authToken !== authToken) {
        const errRes = { success: false, code: 401, message: 'Unauthorized' };
        recordEvent(req.path || '/cloudflare', 401, (Date.now() - startTime) / 1000, 'Unauthorized');
        return res.status(401).json(errRes);
    }

    if ((global as any).browserLimit <= 0) {
        const errRes = { success: false, code: 429, message: 'Too Many Requests' };
        recordEvent(req.path || '/cloudflare', 429, (Date.now() - startTime) / 1000, 'Rate limit / browser busy');
        return res.status(429).json(errRes);
    }

    let cacheKey: string = "", cached;
    if (data.mode === "iuam") {
        cacheKey = JSON.stringify(data);
        cached = await readCache(cacheKey);
        if (cached) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
            const cacheResult = { ...cached, cached: true, elapsed };
            recordEvent(req.path || '/cloudflare', 200, (Date.now() - startTime) / 1000, 'IUAM (from cache)');
            return res.status(200).json(cacheResult);
        }
    }

    stats.in_flight++;
    (global as any).browserLimit--;
    let result: any;
    let page;

    try {
        page = await getPage();

        switch (data.mode) {
            case "turnstile":
                result = await turnstile(data as any, page)
                    .then(token => ({ success: true, token, message: "Turnstile challenge successfully solved" }))
                    .catch(err => ({ success: false, code: 500, message: err.message }));
                break;

            case "iuam":
                result = await iuam(data as any, page)
                    .then(r => ({ success: true, message: r.message || "Cloudflare IUAM challenge successfully cleared", ...r }))
                    .catch(err => ({ success: false, code: 500, message: err.message }));

                if (!result.code || result.code === 200) {
                    const ttl = Number(data.ttl || data.expire) || CACHE_TTL;
                    await writeCache(cacheKey, result, ttl);
                }
                break;

            default:
                result = { success: false, code: 400, message: 'Invalid mode' };
        }
    } catch (err: any) {
        result = { success: false, code: 500, message: err.message };
    } finally {
        if (page) {
            try { await page.close(); } catch { }
        }
        (global as any).browserLimit++;
        stats.in_flight--;
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    if (!result.elapsed) {
        result.elapsed = elapsedSec.toFixed(2) + 's';
    }

    const statusCode = result.code ?? 200;
    const summary = result.message || (result.token ? 'Turnstile token solved' : (result.cf_clearance ? 'cf_clearance acquired' : 'Completed'));
    recordEvent(req.path || '/cloudflare', statusCode, elapsedSec, summary);

    res.status(statusCode).json(result);
};

app.post('/cloudflare', handleCloudflare);

app.post('/solve', async (req: Request, res: Response): Promise<any> => {
    const { sitekey, siteurl, timeout, action } = req.body || {};
    req.body = {
        mode: 'turnstile',
        siteKey: sitekey || req.body?.siteKey,
        domain: siteurl || req.body?.domain || req.body?.url,
        timeOut: timeout ? timeout * 1000 : undefined,
        action
    };
    return handleCloudflare(req, res);
});

app.post('/solve-challenge', async (req: Request, res: Response): Promise<any> => {
    const { siteurl, timeout } = req.body || {};
    req.body = {
        mode: 'iuam',
        domain: siteurl || req.body?.domain || req.body?.url,
        timeOut: timeout ? timeout * 1000 : undefined
    };
    return handleCloudflare(req, res);
});

// Serve WebUI dashboard
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// Stats API (Violetics compatible)
app.get('/stats', (req: Request, res: Response) => {
    const total = stats.solved + stats.challenges + stats.errors;
    const success = stats.solved + stats.challenges;
    const success_rate = total > 0 ? Math.round((success / total) * 100) : 100;

    let avg = 0, p95 = 0;
    if (stats.durations.length > 0) {
        const sorted = [...stats.durations].sort((a, b) => a - b);
        avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
        const p95Idx = Math.floor(sorted.length * 0.95);
        p95 = Math.round(sorted[p95Idx] || sorted[sorted.length - 1]);
    }

    res.json({
        uptime: process.uptime(),
        mode: "hybrid",
        browser_ready: !!(browser && browser.isConnected && browser.isConnected()),
        in_flight: stats.in_flight,
        solved: stats.solved,
        challenges: stats.challenges,
        errors: stats.errors,
        total_requests: total,
        success_rate,
        latency_ms: { avg, p95 },
        events: stats.events
    });
});

// Logs API
app.get('/api/logs', (req: Request, res: Response) => {
    res.json({
        logs: logBuffer,
        browserReady: !!(browser && browser.isConnected && browser.isConnected()),
        browserLimit: (global as any).browserLimit,
        uptime: process.uptime()
    });
});

app.delete('/api/logs', (req: Request, res: Response) => {
    logBuffer.length = 0;
    res.json({ success: true, message: 'Logs cleared' });
});

app.use(async (req: Request, res: Response) => {
    res.status(404).json({ message: 'Not Found' });
});

export default app;
