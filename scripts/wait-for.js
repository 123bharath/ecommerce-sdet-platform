/**
 * Universal service readiness poller using Node.js built-in fetch.
 * Polls a target URL until it returns a 2xx status code or times out.
 */

const targetUrl = process.argv[2];
const timeoutSeconds = parseInt(process.argv[3] || "30", 10);

if (!targetUrl) {
    console.error("Usage: node scripts/wait-for.js <url> [timeoutSeconds]");
    process.exit(1);
}

async function poll() {
    console.log(`[Wait-For] Polling ${targetUrl} (timeout: ${timeoutSeconds}s)...`);
    const startTime = Date.now();

    while ((Date.now() - startTime) < timeoutSeconds * 1000) {
        try {
            const res = await fetch(targetUrl);
            if (res.ok) {
                console.log(`[Wait-For] Service is ready at ${targetUrl} (Status ${res.status}).`);
                process.exit(0);
            }
        } catch {
            // Service not yet listening or connection refused
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.error(`[Wait-For] Timeout exceeded (${timeoutSeconds}s) waiting for ${targetUrl}.`);
    process.exit(1);
}

poll();
