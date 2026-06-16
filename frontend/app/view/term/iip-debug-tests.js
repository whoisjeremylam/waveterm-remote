/**
 * IIP Debug Test Script
 * 
 * Run this from the browser console after the terminal is loaded:
 * 
 *   copy and paste this entire script into the console, or
 *   paste individual test functions
 * 
 * All output is prefixed with [IIP-TEST] for easy filtering.
 */

(function() {
    const prefix = '[IIP-TEST]';
    
    function log(...args) {
        console.log(prefix, ...args);
    }
    
    function error(...args) {
        console.error(prefix, ...args);
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 1: Verify terminal and addon are available
    // ═══════════════════════════════════════════════════════════
    window.__testIIPAvailability = function() {
        log('=== Test 1: Availability ===');
        
        const term = window.__term;
        const addon = window.__imageAddon;
        
        if (!term) { error('No __term found'); return false; }
        if (!addon) { error('No __imageAddon found'); return false; }
        
        log('Terminal exists:', !!term);
        log('Addon exists:', !!addon);
        log('Addon storageUsage:', addon.storageUsage);
        log('Addon storageLimit:', addon.storageLimit);
        
        // Check internal state
        const core = term._core;
        const inputHandler = core?._inputHandler;
        const parser = inputHandler?._parser;
        const oscParser = parser?._oscParser;
        
        log('Core exists:', !!core);
        log('InputHandler exists:', !!inputHandler);
        log('Parser exists:', !!parser);
        log('OscParser exists:', !!oscParser);
        
        if (oscParser) {
            const handlers = oscParser._handlers;
            const ids = Object.keys(handlers).filter(k => !isNaN(Number(k))).map(Number);
            log('All registered OSC IDs:', ids);
            
            const h1337 = handlers[1337];
            log('Handlers for OSC 1337:', h1337?.length ?? 0);
            if (h1337) {
                h1337.forEach((h, i) => {
                    log(`  Handler ${i}:`, h?.constructor?.name, typeof h?.start, typeof h?.put, typeof h?.end);
                });
            }
        }
        
        return true;
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Write minimal IIP sequence directly
    // ═══════════════════════════════════════════════════════════
    window.__testIIPMinimal = function() {
        log('=== Test 2: Minimal IIP ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        // Minimal valid IIP: empty image (0 bytes)
        const seq = '\x1b]1337;File=inline=1;size=0:\x07';
        log('Writing:', JSON.stringify(seq));
        log('Length:', seq.length);
        
        term.write(seq);
        log('Write completed');
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Write IIP with tiny valid PNG
    // ═══════════════════════════════════════════════════════════
    window.__testIIPPng = function() {
        log('=== Test 3: IIP with PNG ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        // 1x1 red pixel PNG
        const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
        const size = Math.ceil(tinyPng.length * 3 / 4);
        const seq = `\x1b]1337;File=inline=1;size=${size}:${tinyPng}\x07`;
        
        log('PNG base64 length:', tinyPng.length);
        log('Computed size:', size);
        log('Total sequence length:', seq.length);
        
        term.write(seq);
        log('Write completed');
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Write IIP as separate chunks (simulating PTY)
    // ═══════════════════════════════════════════════════════════
    window.__testIIPChunked = function() {
        log('=== Test 4: Chunked IIP ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
        const size = Math.ceil(tinyPng.length * 3 / 4);
        
        // Split into chunks like WaveTerm does
        const header = `\x1b]1337;File=inline=1;size=${size}:`;
        const payload = tinyPng;
        const terminator = '\x07';
        
        log('Chunk 1 (header):', header.length, 'bytes');
        log('Chunk 2 (payload):', payload.length, 'bytes');
        log('Chunk 3 (terminator):', terminator.length, 'bytes');
        
        term.write(header);
        setTimeout(() => {
            term.write(payload);
            setTimeout(() => {
                term.write(terminator);
                log('All chunks written');
            }, 10);
        }, 10);
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Write IIP as Uint8Array (like WaveTerm)
    // ═══════════════════════════════════════════════════════════
    window.__testIIPUint8 = function() {
        log('=== Test 5: Uint8Array IIP ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
        const size = Math.ceil(tinyPng.length * 3 / 4);
        const str = `\x1b]1337;File=inline=1;size=${size}:${tinyPng}\x07`;
        
        // Convert to Uint8Array like base64ToArray does
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            bytes[i] = str.charCodeAt(i);
        }
        
        log('Uint8Array length:', bytes.length);
        log('First 20 bytes:', Array.from(bytes.slice(0, 20)));
        
        term.write(bytes);
        log('Write completed');
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 6: Check parser state after write
    // ═══════════════════════════════════════════════════════════
    window.__testIIPParserState = function() {
        log('=== Test 6: Parser State ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        const core = term._core;
        const parser = core?._inputHandler?._parser;
        
        if (!parser) { error('No parser'); return; }
        
        log('Parser currentState:', parser.currentState);
        log('Parser initialState:', parser.initialState);
        
        // Check if parser is in a stuck state
        if (parser.currentState !== parser.initialState) {
            log('WARNING: Parser is not in initial state!');
            log('This might indicate a stuck escape sequence');
        }
        
        // Check parse stack
        const stack = parser._parseStack;
        if (stack) {
            log('Parse stack state:', stack.state);
            log('Parse stack paused:', stack.paused);
        }
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 7: Monitor storage usage
    // ═══════════════════════════════════════════════════════════
    window.__testIIPMonitor = function() {
        log('=== Test 7: Monitor Storage ===');
        
        const addon = window.__imageAddon;
        if (!addon) { error('No addon'); return; }
        
        let lastUsage = addon.storageUsage;
        log('Starting monitor, current usage:', lastUsage);
        
        const interval = setInterval(() => {
            const usage = addon.storageUsage;
            if (usage !== lastUsage) {
                log('Storage usage changed:', lastUsage, '->', usage);
                lastUsage = usage;
            }
        }, 500);
        
        log('Monitor started. Stop with clearInterval(' + interval + ')');
        return interval;
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 8: Test Sixel (control - should work)
    // ═══════════════════════════════════════════════════════════
    window.__testSixel = function() {
        log('=== Test 8: Sixel (Control) ===');
        
        const term = window.__term;
        if (!term) { error('No terminal'); return; }
        
        // Simple Sixel: 2x2 red rectangle
        // ESC P 0;0;0 q 1 ; 2 ; 48 ; 2 r 2 ! 2 ~ 1 ; 2 ; 48 ; 2 r 2 ! 2 ~ ESC \
        const sixel = '\x1bP0;0;0q"1;2;48;2#1;2;48;2#1!100~-\x1b\\';
        log('Writing Sixel sequence');
        term.write(sixel);
        log('Write completed');
    };

    // ═══════════════════════════════════════════════════════════
    // TEST 9: Run all tests in sequence
    // ═══════════════════════════════════════════════════════════
    window.__testIIPAll = async function() {
        log('=== Running All Tests ===');
        
        if (!window.__testIIPAvailability()) {
            error('Availability test failed, stopping');
            return;
        }
        
        // Test 2: Minimal
        log('\n--- Test 2: Minimal IIP ---');
        window.__testIIPMinimal();
        await new Promise(r => setTimeout(r, 500));
        window.__testIIPParserState();
        
        // Test 3: PNG
        log('\n--- Test 3: IIP with PNG ---');
        window.__testIIPPng();
        await new Promise(r => setTimeout(r, 500));
        window.__testIIPParserState();
        
        // Test 5: Uint8Array
        log('\n--- Test 5: Uint8Array IIP ---');
        window.__testIIPUint8();
        await new Promise(r => setTimeout(r, 500));
        window.__testIIPParserState();
        
        log('\n=== All tests completed ===');
        log('Check console for [IIP-DEBUG] logs from patched handlers');
        log('Check terminal for image output');
    };

    log('IIP Test Script loaded');
    log('Available tests:');
    log('  __testIIPAvailability()  - Check terminal/addon state');
    log('  __testIIPMinimal()       - Write minimal IIP');
    log('  __testIIPPng()           - Write IIP with PNG');
    log('  __testIIPChunked()       - Write IIP in chunks');
    log('  __testIIPUint8()         - Write IIP as Uint8Array');
    log('  __testIIPParserState()   - Check parser state');
    log('  __testIIPMonitor()       - Monitor storage usage');
    log('  __testSixel()            - Test Sixel (control)');
    log('  __testIIPAll()           - Run all tests');
    log('');
    log('Also available from termwrap.ts:');
    log('  __testIIP()              - Quick IIP test');
    log('  __testIIPHeader()        - IIP header test');
    log('  __testOsc1337()          - Empty OSC 1337');
})();
