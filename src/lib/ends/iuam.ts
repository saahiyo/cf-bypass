const fs = require('fs');
const path = require('path');

interface CloudflareData {
    domain: string;
    proxy?: {
        username?: string;
        password?: string;
    };
}

async function cloudflare(data: CloudflareData, page: any): Promise<any> {
    return new Promise(async (resolve, reject) => {
        if (!data.domain) return reject(new Error("Missing domain parameter"));

        let targetUrl = data.domain.trim();
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = 'https://' + targetUrl;
        }

        const startTime = Date.now();
        let isResolved = false;
        const timeout = (global as any).timeOut || 60000;
        let checkCookiesInterval: any = null;

        const cleanup = () => {
            if (checkCookiesInterval) {
                clearInterval(checkCookiesInterval);
                checkCookiesInterval = null;
            }
        };

        const cl = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                cleanup();
                reject(new Error("Timeout Error"));
            }
        }, timeout);

        const finish = (result: any) => {
            if (!isResolved) {
                isResolved = true;
                cleanup();
                clearTimeout(cl);
                resolve(result);
            }
        };

        try {
            if (data.proxy?.username && data.proxy?.password) {
                await page.authenticate({
                    username: data.proxy.username,
                    password: data.proxy.password,
                });
            }

            console.log(`[iuam] Preparing navigation for: ${targetUrl}`);

            page.removeAllListeners("request");
            page.removeAllListeners("response");
            await page.setRequestInterception(true);

            page.on("request", async (req: any) => {
                try {
                    const reqUrl = req.url();
                    const type = req.resourceType();

                    if (reqUrl.includes("challenges.cloudflare.com/turnstile/v0/b/88d68f5d5ea3/api.js")) {
                        const localPath = path.join(__dirname, '../js/api.js');
                        try {
                            const body = fs.readFileSync(localPath);
                            return await req.respond({
                                status: 200,
                                contentType: 'application/javascript',
                                body: body,
                                headers: {
                                    'Access-Control-Allow-Origin': '*'
                                }
                            });
                        } catch (e) {
                            return await req.continue();
                        }
                    }

                    // Only abort heavy video/audio media; keep documents, scripts, styles, etc.
                    if (type === "media") {
                        return await req.abort();
                    }

                    await req.continue();
                } catch (_) {
                    try { await req.continue(); } catch {}
                }
            });

            page.on("response", async (res: any) => {
                try {
                    const headers = res.headers();
                    if (headers["set-cookie"]) {
                        const match = headers["set-cookie"].match(/cf_clearance=([^;]+)/);
                        if (match) {
                            const cf_clearance = match[1];
                            const userAgent = (await res.request().headers())["user-agent"] || await page.evaluate(() => navigator.userAgent);
                            const elapsedTime = (Date.now() - startTime) / 1000;
                            let cookies: any[] = [];
                            try { cookies = await page.cookies(); } catch (_) { }

                            console.log(`[iuam] Found cf_clearance in response header!`);
                            finish({
                                cf_clearance,
                                user_agent: userAgent,
                                cookies,
                                final_url: page.url(),
                                elapsed: elapsedTime.toFixed(2) + 's',
                            });
                        }
                    }
                } catch (_) { }
            });

            // Poll cookies every 800ms in case cf_clearance is set via document.cookie or redirect
            checkCookiesInterval = setInterval(async () => {
                if (isResolved) return;
                try {
                    const cookies = await page.cookies();
                    const clearance = cookies.find((c: any) => c.name === 'cf_clearance');
                    if (clearance) {
                        const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
                        const elapsedTime = (Date.now() - startTime) / 1000;
                        console.log(`[iuam] Found cf_clearance in browser cookies!`);
                        finish({
                            cf_clearance: clearance.value,
                            user_agent: userAgent,
                            cookies,
                            final_url: page.url(),
                            elapsed: elapsedTime.toFixed(2) + 's',
                        });
                    }
                } catch (_) { }
            }, 800);

            console.log(`[iuam] Navigating to: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e: any) => {
                console.log(`[iuam] Navigation note: ${e.message}`);
            });

            // Wait a bit to see if clearance appears or if the page loaded completely
            let waited = 0;
            while (!isResolved && waited < 20000) {
                await new Promise(r => setTimeout(r, 1000));
                waited += 1000;

                const title = await page.title().catch(() => '');
                if (title && !title.includes('Just a moment') && !title.includes('Attention Required')) {
                    const cookies = await page.cookies().catch(() => []);
                    const clearance = cookies.find((c: any) => c.name === 'cf_clearance');
                    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
                    const elapsedTime = (Date.now() - startTime) / 1000;

                    console.log(`[iuam] Page verified clear: "${title}"`);
                    finish({
                        cf_clearance: clearance ? clearance.value : null,
                        message: clearance ? 'Bypassed IUAM' : 'Page accessible without IUAM',
                        title,
                        user_agent: userAgent,
                        cookies,
                        final_url: page.url(),
                        elapsed: elapsedTime.toFixed(2) + 's',
                    });
                    break;
                }
            }

        } catch (err: any) {
            cleanup();
            if (!isResolved) {
                isResolved = true;
                clearTimeout(cl);
                reject(err);
            }
        }
    });
}

export = cloudflare;
