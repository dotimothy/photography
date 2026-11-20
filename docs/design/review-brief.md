# TheDoShoots design review brief (phase 1: research and audit)

Date: 2026-11-18. Scope: research and audit only; no repository file was edited.
Audited build: `http://127.0.0.1:8765/build/` as it stood before the current engineering round (commit `2b74d58`).
Everything in section 2 must be re-shot after the merge before any of section 3 is implemented.

Paths used below:

- `SHOTS` = `/private/tmp/claude-501/-Users-tim-Documents-GitHub-photography/f5876a9b-910d-48cd-82f7-b43a1e5923c9/scratchpad/design/shots`
- `REFS` = `/private/tmp/claude-501/-Users-tim-Documents-GitHub-photography/f5876a9b-910d-48cd-82f7-b43a1e5923c9/scratchpad/design/refs`
- Reference capture script: `.../scratchpad/design/ext.mjs` (`node ext.mjs <name> <url> [textToClick]` writes `REFS/<name>-d0.png` (1.5 s, loader state), `-d.png` (8 s), `-d2.png` (after scrolling), `-m.png` (390x844), and `<name>.json` with fonts, link list, transfer size). `.../design/sheet.sh <name>` builds `REFS/<name>-sheet.png` (one contact sheet per site).

Fixed owner direction that every recommendation respects: dark space theme stays; heavily 3D and animation-forward, but it is a photography portfolio; no game mechanics; fewer overlapping buttons; mobile controls that feel part of the experience; every button label in Title Case.

---

## 1. Reference research

### 1.1 Sites actually opened (rendered in headless Chrome, screenshots saved)

Award status is as shown on the Awwwards listing or detail page on 2026-11-18 unless noted. "Observed" means seen in my own screenshots or the extracted page text, not taken from a write-up.

| # | Site | Status | Contact sheet |
|---|---|---|---|
| 1 | Jon McCormack, fine-art nature. https://jonmccormack.com/ | Awwwards Nominee, Oct 29 2026 (tags: Big Background Images, Minimal, Transitions; GSAP) | `REFS/jonmccormack-sheet.png`, `REFS/jon-polar-sheet.png`, `REFS/jon-contact-sheet.png` |
| 2 | Aaron Brimhall, action and automotive. https://www.aaronbrimhall.com/ | Awwwards Nominee, Oct 29 2026 (BEEM Studio; Webflow, GSAP, WebGL) | `REFS/brimhall-sheet.png`, `-project-`, `-contact-`, `-about-sheet.png` |
| 3 | Ethan W, wedding and editorial. https://ethanwong.photography/ | Awwwards Honorable Mention, Sep 15 2026 | `REFS/ethanwong-sheet.png`, `REFS/ethan-contact-sheet.png`, `REFS/ethan-pricing-sheet.png` |
| 4 | Avagyan, wedding. https://avagyanphoto.com/ | Awwwards Honorable Mention, Dec 29 2025 | `REFS/avagyan-sheet.png`, `REFS/avagyan-contact-sheet.png` |
| 5 | CREAMU "Photography that Moves". https://photography.creamu.co.jp/ | Listed in Awwwards photography category, no badge shown | `REFS/creamu-sheet.png` |
| 6 | Per Appelgren, fashion. https://perappelgren.de/ | Awwwards Honorable Mention, Sep 30 2026 | `REFS/appelgren-sheet.png` |
| 7 | Almira Kho, music and fashion. https://almirakho.com/ | Awwwards Honorable Mention, Sep 29 2026 | `REFS/almirakho-sheet.png` |
| 8 | Danielle Levitt, portrait. https://www.daniellelevitt.com/ | Awwwards Site of the Day, Aug 25 2022 (from a search listing; the detail page was not opened) | `REFS/levitt-sheet.png` |
| 9 | Ross Halfin, music. https://www.rosshalfin.com/ | Listed on Awwwards, no badge shown | `REFS/halfin-sheet.png` |
| 10 | TERAKAWA Photo Office, architecture. https://www.terakawaoffice.com/en/ | Awwwards Nominee, Nov 9 2026; CSS Design Awards Special Kudos 2026 (badge on the site itself) | `REFS/terakawa-sheet.png`, `-contact-`, `-works-sheet.png` |
| 11 | HOLMCHROME, portrait concept (a Framer template, not a working photographer). https://holmchrome.byholm.co/ | Awwwards Honorable Mention, Oct 24 2026 (WebGL, Three.js) | `REFS/holmchrome-sheet.png` |
| 12 | Constellation(s), 3D exhibitions of landscape, night and astro photographers. https://constellations.icilalune.com/ | Awwwards Nominee, Nov 14 2026 (Three.js, React) | `REFS/constellations-sheet.png`, `REFS/const-milanesi-sheet.png`, `REFS/const-enter-sheet.png` |
| 13 | Photoscoper, nature and wildlife. https://www.photoscoper.co.uk/ | FWA Site of the Day according to its developer's own post (not confirmed on thefwa.com) | `REFS/photoscoper-sheet.png`, `-galleries-`, `-contact-`, `-shop-sheet.png` |
| 14 | Alex Strohl, landscape. https://www.alexstrohl.com/ | Not an award entry; opened for how a landscape photographer handles contact and prints | `REFS/strohl-sheet.png` |
| 15 | Chris Burkard, landscape. https://www.chrisburkard.com/ | Not an award entry; same purpose | `REFS/burkard-sheet.png` |
| 16 | "Where Worlds Take Shape". https://paodao.fr/ | Awwwards Site of the Day, May 3 2026. A playable-world portfolio, not a photographer. Opened as a cautionary 3D reference | `REFS/paodao-sheet.png` |
| 17 | Mario Dragicevic (the "GETZ" site). https://mariodragicevic.com/ | Awwwards Site of the Day 2019 per the Bornfight write-up. The live site today is a later rebuild, so the 2019 design was not seen | `REFS/getz-sheet.png` |

Also opened but excluded as not photographer portfolios: Gallery Play, Atmos Gallery, Agnes Toth.

### 1.2 Unverified (would not load; described from write-ups only, or not at all)

- Mathijs Hanenkamp, https://mathijshanenkamp.com/ (Awwwards Honorable Mention, Feb 21 2023). Timed out three times. Source used: the developer's own case study, https://www.hontran.dev/blog/mathijs-hanenkamp-photography-portfolio-case-study, which is promotional.
- Peter van Alphen, https://petervanalphen.com/ (CSSDA and Awwwards per Communication Arts). Timed out. Source: https://www.commarts.com/webpicks/peter-van-alphen
- Madeleine Dalla, https://www.madeleinedalla.com/ (Awwwards Site of the Month, March 2020). Blocked by Cloudflare (403). Source: https://www.awwwards.com/madeleine-dalla-wins-site-of-the-month-march-2020.html
- GETZ 2019 design. Source: https://bornfight.com/blog/getz-website-wins-awwwards-site-of-the-day
- Hannah Miles (timeout), OBSESD and Alma Photographie (DNS failure), Reuben Wu (403), the Codrops Motoyoshi Takamitsu case study (403): nothing taken from these.
- FWA and CSS Design Awards archives: I could not get a usable photography listing out of either. The only FWA-linked example is Photoscoper, and the only CSSDA-linked one opened is Terakawa. The research is therefore weighted toward Awwwards.

### 1.3 Patterns, each tied to where it was seen

**Presenting and sequencing photographs**

- A1. The first screen is a photograph plus one sentence of the photographer's own position. McCormack's cover is a full-bleed aurora with "WONDER IS THE BEGINNING OF CARE" and a single "Enter" button; the photo changes behind the line. Photoscoper's loader says who he is before anything else.
- A2. Collections are named as ideas and are short. McCormack: "Polar Patterns. Patterns from cold places.", 17 frames, counter "1 / 17", thumbnail filmstrip. Constellation(s): "Until the Stars", "05 Series / 25 Photographs", with a one-paragraph premise ("scroll forward as the sky darkens, until only the stars remain"). Terakawa numbers works "No.01 ... 2024". None of the award entries show an unedited dump; the largest single series seen was about 40 frames (Photoscoper lists counts per gallery: 27, 39, 4, 36, 24, 43).
- A3. The image is never covered. McCormack frames on white with generous margin; Brimhall goes full-bleed with the title set on the lower edge; Avagyan puts the caption on hover only. The Hanenkamp case study states the rule as "Never degrade the image" (unverified source).
- A4. Captions are one quiet typographic line, and camera data is used as a design element. HOLMCHROME's only on-screen text is "01 / 13 · GOLDEN HOUR · ISO 400 · F/2.8 · 1/125". Brimhall overlays "REC 00:00:13:05" and "SHUTTER 1/250 · ISO 100 · RAW" on stills and counts "FRAME 04 / 23". Halfin sets subject, place and year beside the frame.

**Typography and wordmark**

- B1. One wordmark, used the same way everywhere, often at very large scale and interacting with the photographs (Levitt's name runs behind the pictures; Photoscoper's name is a dark ghost layer the landscape sits on; CREAMU's headline has photos drifting through the letterforms).
- B2. Two faces with clear jobs: a display face for names and series, a small utility face for data. Brimhall: light italic grotesque for titles, IBM Plex Mono for every label. McCormack: Aeonik plus Cormorant italic for series names. Terakawa: EB Garamond plus Inter. Nobody uses one family at one weight for everything, and nobody uses emoji as iconography.
- B3. One accent colour, used sparingly: Brimhall magenta, Photoscoper gold, Ethan W a single red.

**Navigation**

- C1. Two to five words, as text. Appelgren: "Archive", "Contact". Almira Kho: "Works", "About", "IG". Brimhall: "Gallery", "About", "Contact". McCormack: five words. Utilities are separated from destinations and kept tiny: Constellation(s) inside the 3D exhibition shows three small icons (settings, sound, fullscreen) in one corner and nothing else.
- C2. Contact is always one of those words, and often visually distinct: Terakawa's filled "CONTACT" button and floating "Enquire" pill; Ethan W's red "Inquire" tab.

**Motion**

- D1. Motion is tied to a photographic metaphor rather than decoration. Awwwards lists Brimhall's highlighted elements as "Exposure: Develop & Burn-Through Loader", "Through the Lens", "Contact Sheet"; his home masks footage inside the monogram. Terakawa's hero is "Light, recomposed": hold to move the light, the photo breaks into a relief of points and resolves into the next frame.
- D2. What moves: the transition into and between photographs, titles, and hover states. What stays still: the photograph once it is on screen.
- D3. Deliberate entry gestures: "Enter" (McCormack), "Press & Hold To Enter" (Photoscoper), "Scroll To Move Forward" (Constellation(s)). One instruction, in a few words, on screen only until used.

**Loading and performance**

- E1. The loader carries the brand and real progress: Avagyan shows the wordmark and a percentage; Brimhall the monogram; Photoscoper a line of voice. The Hanenkamp write-up describes the hero image starting to settle before the loader clears so there is no dead frame (unverified source).
- E2. Weight is where entries fail. Measured transfer on first load: CREAMU about 28 MB, Constellation(s) exhibition about 11.7 MB, McCormack about 6 MB, Photoscoper about 3 MB, Brimhall and Avagyan under 1 MB before lazy loads. Constellation(s) answers its weight with "Download For Offline" and an install prompt.

**3D and WebGL used well**

- F1. The 3D exists to stage the photographs, and they stay large and flat-on. In Constellation(s) "Until the Stars" the world is low-poly and muted so the pictures are the only detailed, saturated objects; they are grouped by series along a path; the environment itself carries the series' idea (the sky darkens as you advance). `REFS/const-enter-sheet.png`.
- F2. An introduction panel precedes the 3D: portrait, premise, counts, one "Enter Exhibition" button. `REFS/const-milanesi-sheet.png`.
- F3. Honest mobile fallback: Constellation(s) on a phone offers "Enter The 2D Exhibition" first and "Turn Your Phone Sideways To Explore The Exhibition In 3D" second.
- F4. Counter-example: paodao.fr won Site of the Day as a playable world, with Usability its lowest score (6.81 against Creativity 7.74) and a loader that has to teach controls. This is the game direction the owner has already rejected.

**Mobile**

- G1. Ethan W uses a bottom tab bar (Home, Galleries, Pricing, About) with "Inquire" as a separate red pill. Photoscoper and Brimhall collapse to wordmark plus one menu control. Nothing overlaps the photograph.

**Voice**

- H1. First person, specific, short. Brimhall: "One operating principle: fun fuels creativity. Not just capturing light. Capturing life." Ethan W's contact page: "Tell me what you're planning, and I'll write back myself." Photoscoper: "A self proclaimed amateur nature photographer." and, on an unfinished shop, "The shop isn't quite ready yet". Hobbyist honesty reads well; it is not hidden.

**Contact, booking, licensing, prints**

- I1. Contact stays inside the site's own design. Brimhall: a drawer slides over the blurred scene, headline "TELL ME ABOUT THE PROJECT", three fields, button "TRANSMIT" (`REFS/brimhall-contact-sheet.png`). Photoscoper: full page "QUESTIONS? CONTACT ME" with a conversational paragraph and three fields.
- I2. Where there is no form, the address itself is the design. Levitt's second screen is the bio sentence and contacts in display type, split by purpose: Studio, Syndication (licensing), Agent. Appelgren lists addresses by role. HOLMCHROME ends with the address alone.
- I3. Expectation setting sits next to the call to action: "NOW BOOKING 2027 & 2028" and location line (Ethan W), office hours (Terakawa), "I'll respond as quickly as possible" (Photoscoper).
- I4. Inquiry is typed. Terakawa's form starts with "What kind of commission is it?"; Avagyan qualifies by event type. Levitt separates licensing from commissions entirely.
- I5. A contact prompt closes every body of work: Brimhall ends each project with "LET'S MAKE SOMETHING / OPEN CHANNEL"; Terakawa repeats "Commission A Shoot / View Selected Works".
- I6. Prints are a nav item only when there is a real shop (Halfin, Burkard's separate shop domain, Strohl's "Print Shop", Brimhall's link out to a print partner). Otherwise prints are an inquiry type.

### 1.4 What the weaker entries have in common

Drawn from unbadged or low-scoring entries I opened and from the listing pages:

- Chrome competing with photographs: Halfin's cookie banner covers the hero on both desktop and phone; paodao shows instructions before content.
- Weight without payoff (CREAMU's 28 MB for one hero).
- Novelty navigation that costs usability: paodao's lowest score is Usability; Terakawa's individual votes range 5 to 8 with usability and design marked down despite a strong hero idea.
- Template sameness: a uniform grid, a stock sans, no statement of who the photographer is or what the collection is about. The rebuilt Dragicevic site is a competent example of this and carries no current badge.
- No visible way to reach the photographer from inside a gallery.

---

## 2. Audit of the current site

All shots taken with `shot.mjs`; no console errors on any page. WebGL was software-rendered, so only composition is judged.

### 2.1 Home: intro and welcome

`SHOTS/d-home-welcome.png`, `SHOTS/d-home-welcome2.png`

- The first frame is the words "SYSTEM INITIALIZING" and a "SKIP" button. No photograph, no wordmark, generic science-fiction copy (against A1, E1).
- A second gate follows: signature wordmark, eight social icons, then "Explore Portfolio", "About Me", "Contact" stacked, with the eight round icon buttons already showing top right and an FPS badge bottom left. Two screens pass before any photograph is seen.
- The signature wordmark is cut off at the right edge in my capture ("TheDoShoo"). This may be a reveal animation caught mid-way; verify on real hardware.
- "Contact" here is the smallest of three buttons and opens the Google Form in a new tab.

### 2.2 Home: 3D camera, desktop

`SHOTS/d-home-3d.png`, `SHOTS/d-home-3d-inspector.png`, `SHOTS/d-home-3d-settings.png`

- The camera model is distinctive and is the site's real asset. No reference site has anything like it.
- The LCD's first state shows the owner's portrait and six emoji-labelled menu rows. A camera's screen with no photograph on it (against A1, F1).
- Eight identical, unlabelled round icon buttons run across the top right (home, person, sound, cube, magnifier, undo, sliders, fullscreen). Destinations and utilities are mixed (against C1). The inspector panel covers four of them when open.
- The exposure readout "RAW ISO 3200 1/250 f/1.8" is a good in-world device but is static decoration; the references use real data (A4).
- Further labels compete: "SETTINGS" and "STAR DRIFT" on the top plate, "HOME / MODE / PLAY" on the back, "FULL GALLERIES", the hint line "SHUTTER: LIVE SPACE / VIEWFINDER: PHOTOGRAPHS".
- The copyright line overlaps an asteroid at the bottom; the FPS badge and a gear sit bottom left on every page.
- There is no Contact entry anywhere in this state. On the homepage it exists only on the welcome screen.

### 2.3 Home: 3D camera, phone

`SHOTS/m-home.png`, `SHOTS/m-home-menu.png`

- Good: the scene and a photograph on the LCD appear immediately.
- Four tiers of controls surround the camera: header (wordmark, "Menu"), a hint sentence, a "Collection" select plus a "Shutter" disc, then three chips ("Camera Menu", "Space", "AI Inspect"). The native select and the chips read as web form controls beside the camera, not as part of it.
- The LCD's own buttons ("METADATA", "FULL GALLERY", "NEXT SHOT", "STEP BACK") render about 7 px tall at this size; they are not usable as touch targets and duplicate the chips.
- The menu sheet has a select and eight rows mixing destinations (Browse Photos, About) with utilities (Sound, Switch 2D / 3D, Reset View, Settings, Fullscreen). No Contact row.

### 2.4 Home: 2D mode

`SHOTS/d-home-2d.png`, `SHOTS/m-home-2d.png`

- Desktop: a teal gradient with a scan-line texture replaces the space scene, so 2D mode looks like a different site. The wordmark is heavy Roboto with a cyan glow. The portrait is the largest image above the fold.
- The collection cards put a dark overlay, an emoji and "Explore Astronomy" over each photograph (against A3). The copyright line overlaps the second row of cards.
- Phone: cleaner, but the same overlay and generic sub-labels.

### 2.5 Gallery: 3D shape

`SHOTS/d-gallery.png`, `SHOTS/d-gallery-astro.png`, `SHOTS/m-gallery.png`, `SHOTS/d-gallery-menu.png`

- The shape occupies roughly a quarter of the viewport and each photograph is around 40 px wide. It reads as confetti; no single picture can be seen (against F1).
- No introduction: no statement, no count, no cue for what to do (against A2, F2, D3).
- A raw "FPS: 21" readout sits under the back button. The title is wrapped in emoji. "View Sphere" is unexplained. The copyright line overlaps the star field.
- The menu opens four more unlabelled round icons (reload, settings, fullscreen, "2D").

### 2.6 Gallery: 2D grid

`SHOTS/d-gallery-2d.png`, `SHOTS/m-gallery-2d.png`

- Uniform five-column crops with a watermark on every thumbnail. Near-duplicates sit side by side (three seals in the same water, two frames of the same sparrow). Wildlife has 80 frames. This is an archive, not an edit (against A2).
- Phone: still five columns, so thumbnails are about 54 px wide; the copyright line overlays the grid.

### 2.7 Photo viewer

`SHOTS/d-gallery-photo.png`, `SHOTS/m-gallery-photo.png`, `SHOTS/d-gallery-astro-photo.png`

- Desktop framing is good: the photograph is large on black.
- Defect: the EXIF strip prints raw rationals: "f/28/5", "27/5mm", "f/9/5". Cause: the strip in the gallery's `js/app.js` (lines 844 to 853 in the built copy) interpolates `EXIF FNumber` and `EXIF FocalLength` directly, while the info panel at line 1091 evaluates them. The strip is also low-contrast and touches the image edge.
- The info panel's title is the file name ("20240518_014956.jpg"), rows are emoji-bulleted, the camera is a raw model code ("SM-S901U"), the place is bare coordinates.
- The watermark spans about a fifth of the image width in the viewer.
- Phone: the keyboard hint "← → navigate · Esc close · i info" is shown on a touch device and sits under the "Back to Camera" and "AI Inspector" buttons. A landscape frame fills about 28% of the screen height with empty space above and below.
- No way to ask about the photograph from here (against I5).

### 2.8 About

`SHOTS/d-about.png`, `SHOTS/d-about-cards.png`, `SHOTS/d-about-gear.png`, `SHOTS/m-about.png`

- The best writing on the site: "It started with my father's Canon." This is the voice the home page lacks (H1).
- A fourth wordmark treatment (gradient capitals). Eight equal-weight social icons. The envelope icon is labelled "Email" but opens the Google Form.
- The page ends at the gear list and footer: no closing call to action, no link back to the work (against I5).
- The "Engineer" card image was blank in my capture. It is a lazily loaded cross-origin image; may be a headless artefact. Verify.
- FPS badge shown on a text page.

### 2.9 Links

`SHOTS/d-links.png`, `SHOTS/m-links.png`

- The most composed page and the only one using the signature wordmark at proper size.
- "Let's Make Something: Collaborations, questions, and print inquiries" opens the Google Form, whose inquiry types are "Photoshoot (San Jose, CA)", "Photo Editing", "Website Design", "Advice", "Other". Prints and licensing, which the site advertises, are not options.
- FPS badge again.

### 2.10 Cross-site

- Four wordmark treatments: signature image (links, welcome), glowing Roboto (2D home), gradient capitals (About), plain Roboto with a Courier sub-line (phone header). Against B1.
- Roboto does every job; small labels fall back to Courier New or generic monospace. Against B2.
- Emoji as iconography in the LCD menu, collection cards, gallery titles and info panel.
- Debug furniture in production: FPS badge on every page, raw FPS text in galleries.
- The copyright line overlaps content on home 3D, home 2D, gallery 3D and gallery grid.
- Label case is inconsistent with the owner's rule: "View Sphere", "FULL GALLERIES", "SETTINGS", "Back to Camera", "Data saver (smaller photos)", a "✖️" close glyph.

### 2.11 Facts about the codebase that matter for phase 2

- `build/` is git-ignored and generated. Home, About and links are single files in the repo root (`index.html` 293 KB, `about.html`, `linktree.html`).
- The gallery pages are generated from a separate repository, `github.com/dotimothy/gallery`, cloned to `tmp/gallery` by `preparePortfolio.py` (or supplied with `--gallery-source`). Gallery and viewer changes therefore land either in that repository (`index.html`, `js/app.js`, `js/view3d.js`, `js/view2d.js`, `js/shapes.js`, `css/style.css`) or in the overlay files this repository injects (`assets/js/gallery-return.js`, `assets/css/gallery-return.css`, `assets/js/gallery-inspector.js`, `assets/js/photo-tools.js`). Confirm with the engineering round which route they used.
- Per-photo metadata already carries camera model, lens data, capture date and GPS, so richer captions need no new data except place names and titles.
- The most recent commit configures emoji-silhouette shapes for the 3D galleries. My emoji recommendation concerns text labels only, not those shapes.

---

## 3. Recommendations

Ordered by impact for effort. Each gives the problem, the reference, the change, and the files. All are to be re-checked against the merged site first, since five engineers are changing these same areas.

### 3.1 Would change in phase 2

**R1. Contact panel with typed inquiries, reachable from everywhere.** See section 4. Highest value for least effort, and the owner asked for it by name.

**R2. One cover instead of two gates, with a photograph and a line of voice.**
Problem: "SYSTEM INITIALIZING", then a button stack (`SHOTS/d-home-welcome.png`, `d-home-welcome2.png`).
Reference: A1, E1, D1 (McCormack cover; Brimhall "Develop" loader; Avagyan percentage).
Change: a single opening screen on the star field. The signature wordmark; under it one sentence from the owner (candidate, lifted from his About copy: "Moments where the universe stood still long enough for the shutter to click."); behind them a featured photograph that comes up like an exposure as assets load, with real progress shown as a thin line. One primary button, "Enter", plus "About" and "Contact" as text links. When loading completes, the photograph shrinks into the camera's LCD as the camera arrives, so the first thing on the LCD is that photograph. Social icons leave this screen.
Files: `index.html` (intro and `#welcome-screen` markup, styles, `startExperience`).

**R3. The LCD always shows a photograph; the readout is real.**
Problem: portrait and emoji menu on the LCD (`SHOTS/d-home-3d.png`).
Reference: A4, F1 (HOLMCHROME, Brimhall).
Change: the idle LCD cycles featured frames. The top readout shows the displayed frame's actual ISO, shutter, aperture and focal length from metadata. The collection list becomes plain text rows without emoji, overlaid on the dimmed frame when the menu is opened. The portrait moves to About.
Files: `index.html` (LCD drawing code and data).

**R4. Control diet on the home page.**
Problem: eight unlabelled round icons, plus FPS badge and gear (`SHOTS/d-home-3d.png`); eight-row phone menu (`SHOTS/m-home-menu.png`).
Reference: C1, C2 (Brimhall, Appelgren, Constellation(s)).
Change: top right becomes three text items, "Galleries", "About", "Contact", and one small "More" control holding Sound, Fullscreen, Reset View, Switch To 2D, Settings, AI Inspector. The FPS badge shows only when "Debug Information" is on in Settings (the toggle already exists) or with a debug query parameter. Phone menu: three destination rows, Contact visually distinct, then a "More" group.
Files: `index.html`, `assets/css/mobile-home.css`, `assets/js/live-fps.js`.

**R5. Phone controls become the camera's controls.**
Problem: select, chips and hint text around the camera; unreadable LCD buttons (`SHOTS/m-home.png`).
Reference: G1, D3.
Change: one row at the bottom styled as the camera's own controls: a mode dial for collections (horizontal, swipeable, labelled with names rather than a native select), the shutter, and one "Menu" key. The duplicate chips go. LCD buttons are not drawn at phone size; swipe on the LCD moves between frames, tap enlarges. The hint appears once and fades after first interaction.
Files: `index.html` (`.mobile-scene-dock`), `assets/css/mobile-home.css`.

**R6. Viewer caption line, fixed data, touch-aware hints.**
Problem: "f/28/5", file-name title, emoji rows, keyboard hint on phones (`SHOTS/d-gallery-photo.png`, `m-gallery-photo.png`, `d-gallery-astro-photo.png`).
Reference: A4 (HOLMCHROME, Brimhall "FRAME 04 / 23").
Change: evaluate the rationals; one caption line in the mono face, for example "03 / 80 · Sony A7 IV · 50mm · f/1.8 · 1/250 · ISO 3200", with date beneath; readable camera names for model codes; keyboard hints only on devices with a keyboard; the photograph scaled to the available width on phones; an "Ask About This Photo" link that opens the contact panel with the frame referenced (section 4).
Files: gallery template `js/app.js`, `css/style.css`, `index.html` (other repository), or the overlay files in `assets/`.

**R7. One wordmark, two faces, no emoji in text.**
Problem: four wordmarks, Roboto for everything, emoji labels (2.10).
Reference: B1, B2, B3.
Change: the signature is the only wordmark, at one size per context, ideally as an SVG traced from `assets/watermark.png`. Remove the glow and the gradient capitals. Add one mono face for all camera data and small labels (Roboto Mono keeps the family and costs one request) in place of Courier. Cyan only for the active state and the single primary action per screen. Emoji removed from the LCD rows, cards, gallery titles and info rows.
Files: `index.html`, `about.html`, `linktree.html`, `assets/css/*.css`, gallery template `index.html` and title generation in `preparePortfolio.py` / `modules/builder.py`.

**R8. Gallery entrance and a shape you can actually see.**
Problem: small confetti shape, no introduction (`SHOTS/d-gallery.png`).
Reference: F1, F2, A2 (Constellation(s)).
Change: on entering a collection, a short panel: collection name, one or two sentences in the owner's words, "80 Photographs", and "Enter". Behind it the frames drift in from the star field and assemble into the shape, which is fitted to at least 60% of the shorter viewport side. After assembly the shape turns slowly; hovering or tapping lifts a frame toward the viewer at readable size. "View Sphere" is renamed to say what it does and moves into "More". The raw FPS text goes.
Files: gallery template `js/view3d.js`, `js/shapes.js`, `index.html`, `css/style.css`. Needs five short statements from the owner.

**R9. 2D mode belongs to the same site.**
Problem: teal gradient, glowing title, darkened cards (`SHOTS/d-home-2d.png`).
Reference: A3, Photoscoper's gallery strip (`REFS/photoscoper-galleries-sheet.png`: tall uncovered covers, name and count beneath).
Change: same star-field background as 3D; cards show the photograph uncovered with name and frame count set below it; portrait removed; phone grid in the gallery drops to two or three columns.
Files: `index.html`; gallery template `js/view2d.js`, `css/style.css`.

**R10. About closes with an invitation.**
Problem: page ends at the gear list; "Email" icon opens a form (`SHOTS/d-about-gear.png`).
Reference: I5, I2.
Change: a closing contact section (same component as section 4) and a "See The Work" link. Social row reduced to the three the owner cares most about, with the rest under "More". Envelope icon opens the contact section.
Files: `about.html`.

**R11. Housekeeping that removes overlap.**
Copyright line moved out of the 3D scenes into the menu, About, links and contact pages. Every button label passed through Title Case. `prefers-reduced-motion` respected for the intro and assembly animations.
Files: all pages.

### 3.2 Bigger ideas for the owner to decide

- **B1. Edit each collection down to a sequenced "Selects" set of 12 to 20 frames, with the full archive one step behind it.** This is the single largest difference between this site and the award entries (A2), and it is editorial work only the owner can do.
- **B2. Through-the-viewfinder transition.** Choosing a collection raises the camera to the eye; the EVF fills the screen; the first photograph pulls into focus. It makes the 3D camera the way into the photographs rather than a menu beside them (D1). May overlap with what the 3D engineer is building.
- **B3. One signature effect on the photographs themselves**, in the spirit of Terakawa's "Light, recomposed": for the astronomy collection, a frame that resolves like a long exposure accumulating. One effect, one collection, or it becomes decoration.
- **B4. Titles and place names for the Selects.** Either a column the owner fills in the portfolio sheet, or reverse-geocoding at build time. The second sends photo coordinates to an outside service and exact coordinates of some locations may be better not published; the owner should choose.
- **B5. A display typeface for the wordmark's companion text and series names**, replacing Roboto in that role only.
- **B6. Smaller or no watermark inside the viewer**, keeping it on downloads and shared images.
- **B7. Prints.** If he wants to sell, a real shop link (he already has Pixieset) earns a nav word (I6); until then prints stay an inquiry type.
- **B8. Sound** as a labelled "Sound Off / Sound On" text toggle (Photoscoper's "Audio" control), off by default.
- **B9. Offline and install prompt** for the galleries, as Constellation(s) does; the site already has a service worker.

---

## 4. Contact proposal

### 4.1 What exists

- One Google Form, `https://forms.gle/KvaUyizYpwuKnF868`, opened in a new tab from: the welcome screen button and envelope icon (`index.html` lines 1714 and 1722), About's envelope icon labelled "Email" (`about.html` line 957), and two places on the links page (`linktree.html` lines 738 and 764).
- I fetched the public form once to read its structure. Fields: Name (required), Email (required), Type of Inquiry (required; "Photoshoot (San Jose, CA)", "Photo Editing", "Website Design", "Advice", Other), "How can I help you?" (required), Phone (optional). Its description publishes the address `contact@thedoshoots.me` and opens "Hey Bay Area!".
- Gaps: it leaves the site for a light-themed Google page; its types do not include the prints and licensing the site mentions; there is no contact entry in the 3D camera state, the phone menu, any gallery or the viewer.

### 4.2 Options compared

| Option | For | Against |
|---|---|---|
| A. Keep the link to the Google Form | No work; Google handles spam, storage and notification | Leaves the experience; off-theme; types do not match; nothing contextual |
| B. Address shown large, with "Open In Mail" (prefilled subject and body) and "Copy Address" | No third party, nothing to break, replies thread naturally, works offline, matches the award pattern for sites without a form (I2) | "Open In Mail" does nothing for visitors without a configured mail app, so "Copy Address" must sit beside it; the address is exposed to scrapers (it is already public on the form); no structured record |
| C. Link to the same Google Form, prefilled with the inquiry type (`viewform?usp=pp_url&entry.<id>=...`, a supported Google feature) | Keeps his existing sheet and notifications; type preselected; official | Still leaves the site; option text must match the form exactly |
| D. On-page form in the site's style that posts to the Google Form's response endpoint | Visitor never leaves; no new account; same sheet | Unofficial. The browser cannot read the response, so the page cannot know whether it was delivered; it breaks silently if the form is edited or Google adds sign-in or a challenge; no spam control beyond a hidden field |
| E. On-page form through a form service (Formspree, Web3Forms and similar) | Official, confirmed delivery, spam filtering | A new account and dependency; free-tier limits (not checked); a privacy note becomes necessary |
| F. Booking link (a Google Calendar appointment schedule needs no new account; Calendly does) | Useful if he really takes sessions | Promises availability a hobbyist with a day job may not want to keep; only worth adding if he says he wants calls |

### 4.3 Recommended flow: B as the primary action, C as the alternative, in one panel

One component, `contact.html`, also shown as a panel over the scene using the overlay the home page already uses for About (`handleNav('about.html', true)`).

Layout, top to bottom, on the star field:

1. Headline in his voice, for example "Let's Make Something" (his existing wording on the links page).
2. One line of expectation: where he is based and how soon he replies (I3). Wording from the owner.
3. Inquiry types as four chips: "Prints", "Licensing", "Collaboration", "Session". Choosing one sets the subject and a three-line body template (for Prints: which photograph, size, where it ships).
4. The address in large type, with two buttons: "Open In Mail" (a `mailto:` carrying the subject and body) and "Copy Address" (confirms "Copied").
5. A quiet third link, "Use The Form Instead", opening the Google Form with the type preselected.
6. Three primary social links as text.

Contextual entry, the part that makes it better than a generic page: in the photo viewer, "Ask About This Photo" opens the panel with the type set to Prints and the subject carrying the collection and frame reference (for example "Print inquiry: Astronomy, frame 20240518_014956"), so he knows exactly which picture is meant without the visitor describing it.

Entry points:

- Home, desktop: "Contact" as one of the three text items top right (R4), and on the cover (R2).
- Home, 3D camera: optionally a "Contact" row in the LCD menu that plays a short camera-turns-away move before the panel opens. Optional; the text item is the reliable route.
- Phone: "Contact" as the distinct last destination in the menu sheet (Ethan W's red tab is the model).
- Viewer: "Ask About This Photo" in the info area.
- About: closing section (R10). Links page: the existing row points to `contact.html`.

Trade-offs accepted: no on-page send, so no submission record beyond his inbox and the optional form; a visitor with no mail app must use "Copy Address" or the form. In exchange nothing can fail silently, there is no new account, and it works on GitHub Pages as is. If the owner later wants a true on-page send, E is the sound upgrade; D is possible with the IDs already identified but I would only ship it with the address shown as a fallback on the confirmation and an automated check that the form's fields still match.

Files: new `contact.html`; `index.html` (cover links, top-right item, phone menu, LCD row); `about.html`; `linktree.html`; viewer link in the gallery template or `assets/js/photo-tools.js`; `sw.js` cache list.

### 4.4 Needed from the owner

1. Is `contact@thedoshoots.me` monitored, and may it be shown in large type on the site?
2. Which inquiry types are real for him: prints, licensing, collaborations, sessions, and the form's current "Photo Editing", "Website Design", "Advice"? The site should only offer what he will answer.
3. A reply-time promise he is comfortable with, and the location line ("Based in San Jose, CA"?).
4. Will he update the Google Form's options to match the chosen types (needed for option C's preselection)?
5. Does he want a booking link at all?
6. Is Pixieset a client-delivery space or somewhere prints can be bought?

---

## 5. Other questions for the owner

- May emoji be removed from text labels (LCD rows, cards, gallery titles, info rows) while keeping the emoji-silhouette 3D shapes?
- Is he willing to pick 12 to 20 frames per collection and write one or two sentences for each collection (R8, B1)?
- The opening sentence for the cover: use the line from his About copy, or his own?
- Which three social links matter most?
- Watermark size inside the viewer (B6); place names versus coordinates (B4); typeface latitude beyond Roboto (B5).

## 6. Phase 2 starting checklist

1. Re-run every capture in section 2 against the merged build and diff against `SHOTS/`; strike any finding the engineers already fixed.
2. Confirm where gallery changes live (other repository or overlay files).
3. Check on real hardware: the clipped wordmark on the welcome screen, the blank "Engineer" image on About.
4. Get the answers in 4.4 before building the contact panel; build R1, R2, R4, R6 first.

---

## Owner's answers (2026-11-19)

1. **Contact email:** contact@thedoshoots.me, shown prominently with "Open In Mail" and "Copy Address".
2. **Inquiry types:** Photoshoots / Sessions, Prints, Licensing, Collaboration (each a chip that prefills the email subject). The Google Form stays as a fallback.
3. **Pixieset:** it is the print store. The Prints inquiry and the photo viewer can point to it.
4. **Emoji and type:** remove emoji from text labels (the emoji-shaped 3D gallery layouts stay); add a monospaced typeface for camera data (ISO, f-stop, shutter) alongside Roboto.
5. **Reply time and location:** location only, no reply-time promise. The location text itself is still to be confirmed with the owner; do not guess it.
6. **Cover line:** "Photographs of the moments that make us stop and feel something."
7. **Selects:** build support for a curated per-collection "Selects" list (about 12 to 20 frames); the owner picks the frames later. Full galleries stay available.
8. **Featured socials:** Instagram, YouTube, Flickr. The rest move to a smaller row.
