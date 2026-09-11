const button = document.getElementById('portfolio-inspector');
// The portfolio already supplies an inspector around embedded galleries.
if (window.parent !== window) button.hidden = true;
button.addEventListener('click', async () => {
    button.disabled = true;
    try {
        const { openInspector } = await import('./photo-tools.js');
        await openInspector();
        button.hidden = true;
    } catch {
        button.textContent = 'Retry AI Inspector';
    } finally {
        button.disabled = false;
    }
});
