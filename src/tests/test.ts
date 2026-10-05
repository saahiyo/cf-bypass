const API_URL = `http://localhost:8742/cloudflare`;

const startTest = async () => {
    try {
        const answer = prompt("Which mode do you want to test? (1: turnstile, 2: iuam): ");
        const isTurnstile = answer?.trim() === '1';
        const mode = isTurnstile ? 'turnstile' : 'iuam';

        console.log(`Testing ${API_URL} in ${mode} mode...`);

        const body = isTurnstile ? {
            mode: 'turnstile',
            domain: 'https://2captcha.com/demo/cloudflare-turnstile',
            siteKey: '1x00000000000000000000AA'
        } : {
            mode: 'iuam',
            domain: 'https://sayphotobooth.com'
        };

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        console.log('Status:', response.status);
        console.log('Response:', data);

        if (response.status === 200 && (data?.cf_clearance || data?.token)) {
            console.log("✅ Test Passed");
        } else {
            throw new Error("❌ Test Failed");
        }
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
};

startTest();
