const inquiries = {
    sessions: ['Photoshoot / Session Inquiry', 'Session idea: \r\nPreferred date: \r\nLocation: '],
    prints: ['Print Inquiry', 'Photograph: \r\nPrint size: \r\nShipping destination: '],
    licensing: ['Licensing Inquiry', 'Photograph: \r\nIntended use: \r\nTiming: '],
    collaboration: ['Collaboration Inquiry', 'Project: \r\nWhat you have in mind: \r\nTiming: '],
};
const params = new URLSearchParams(location.search);
const clean = (key) => (params.get(key) || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
const frame = [clean('collection'), clean('frame')].filter(Boolean).join(' / ');
const types = document.getElementById('inquiry-types');
const buttons = [...types.querySelectorAll('button')];
const address = document.getElementById('contact-address');
const mail = document.getElementById('contact-mail');
const copy = document.getElementById('contact-copy');
const status = document.getElementById('contact-status');
const frameLabel = document.getElementById('contact-frame');

function selectInquiry(type) {
    const [title, template] = inquiries[type];
    const subject = frame ? `${title} — ${frame}` : title;
    const body = frame ? template.replace('Photograph: ', `Photograph: ${frame}`) : template;
    mail.href = `mailto:${address.textContent}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.inquiry === type)));
    document.getElementById('contact-prints').hidden = type !== 'prints';
}

buttons.forEach((button) => button.addEventListener('click', () => selectInquiry(button.dataset.inquiry)));
types.hidden = false;
if (frame) {
    frameLabel.textContent = frame;
    frameLabel.hidden = false;
    selectInquiry('prints');
}

copy.hidden = false;
copy.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(address.textContent);
        status.textContent = 'Address Copied';
    } catch {
        const range = document.createRange();
        range.selectNodeContents(address);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        status.textContent = 'Address Selected. Copy It To Your Clipboard.';
    }
});

// The homepage overlay supplies its own close control when it hosts the contact page.
if (window.frameElement?.id === 'exhibit-iframe') {
    document.getElementById('contact-back').hidden = true;
    document.body.classList.add('contact-embedded');
}
