# Assembles the three pages of direction C from one header and stamp so they stay identical.
HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="A signed instruction for how your governance votes are cast. Three model jurors read every proposal against it and a reactive contract votes unless you tear off the veto.">
<link rel="preload" href="fonts/bodoni-moda-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13.5' fill='none' stroke='%235b2c86' stroke-width='3'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%235b2c86'/%3E%3C/svg%3E">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="bar">
  <a class="wordmark" href="index.html" aria-label="Mandate, home">Mandate<i aria-hidden="true"></i></a>
  <nav aria-label="Primary">
    <a href="index.html"{c_home}>The deed</a>
    <a href="docket.html"{c_docket}>Docket</a>
    <span aria-disabled="true">Weights</span>
    <span aria-disabled="true">Radar</span>
  </nav>
</header>
'''
def stamp(cls, label, ring_text, centre, uid):
    return f'''<svg class="{cls}" viewBox="0 0 200 200" role="img" aria-label="{label}">
  <defs>
    <filter id="ink-{uid}" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"/></filter>
    <path id="arc-{uid}" d="M100,100 m-71,0 a71,71 0 1,1 142,0 a71,71 0 1,1 -142,0"/>
  </defs>
  <g filter="url(#ink-{uid})">
    <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" stroke-width="4.5"/>
    <circle cx="100" cy="100" r="86" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="100" cy="100" r="55" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text fill="currentColor" font-family="Archivo, sans-serif" font-weight="700" font-size="14.5" letter-spacing="2.4"><textPath href="#arc-{uid}" textLength="440" lengthAdjust="spacing">{ring_text}</textPath></text>
    {centre}
  </g>
</svg>'''
SEAL = stamp("stamp-mark", "Stamp: mandate version 1", "MANDATE  VERSION 1  HEARD ON BASE SEPOLIA  ",
  '<text x="100" y="121" text-anchor="middle" fill="currentColor" font-family="Bodoni Moda, serif" font-style="italic" font-size="64">M</text>', "seal")
CAST = stamp("ring", "Cast stamp, not yet applied", "CAST BY YOUR DELEGATE  NOT YET  ",
  '<text x="100" y="109" text-anchor="middle" fill="currentColor" font-family="Archivo, sans-serif" font-weight="800" font-size="24" letter-spacing="3">CAST</text>', "cast")
FOOT = '<footer class="colophon"><span>{left}</span><span>Design direction C, Deed</span></footer>\n'

def page(name, title, home, body, left, script=False):
    html = HEAD.format(title=title, c_home=' aria-current="page"' if home else '', c_docket='' if home else ' aria-current="page"')
    html += body.replace("{SEAL}", SEAL).replace("{CAST}", CAST) + FOOT.format(left=left)
    if script: html += '<script src="countdown.js"></script>\n'
    html += '</body>\n</html>\n'
    open(name, "w").write(html)

page("index.html", "Mandate", True, open("parts/index.part").read(),
     "Jurors: Claude Haiku 5.5 (Anthropic), gpt-oss-20b (OpenAI open weights via Pollinations), Qwen 2.5 3B Instruct (self-hosted on Ollama)")
page("docket.html", "Docket, Mandate", False, open("parts/docket.part").read(),
     "Juror prompt juror.v1.md, keccak256 0x4d8c2f41…dda754da9", script=True)
page("hash-mismatch.html", "Opinion does not match its hash, Mandate", False, open("parts/error.part").read(), "Error state")
