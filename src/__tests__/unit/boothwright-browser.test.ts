import { it, expect } from 'vitest';
import { createBoothwrightBrowserHandler } from '../../lib/boothwright-browser.js';
it('is default off without calling the provider', async () => {
 const handler = createBoothwrightBrowserHandler({ enabled: false } as any);
 expect(await handler(new Request('https://as.example/login'))).toBeNull();
});
