// Embedded galleries return to their existing homepage instead of opening a new camera scene.
const returnLink = document.getElementById('portfolio-return');
if (returnLink && window.parent !== window) {
    returnLink.href = '../../index.html';
    returnLink.replaceChildren();
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '←';
    returnLink.append(arrow, ' Back to Main Page');
    returnLink.addEventListener('click', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        try {
            if (typeof window.parent.closeiFrame === 'function') {
                window.parent.closeiFrame();
                event.preventDefault();
            }
        } catch {
            // A cross-origin embed can still follow the ordinary homepage link.
        }
    });
}
