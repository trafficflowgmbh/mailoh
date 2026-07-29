/**
 * The MailOh demo world — every string extracted verbatim from the
 * canonical Blanc prototype (design/proposals/blanc/index.html).
 * This dataset powers the component showcase, the webapp's ?demo mode,
 * app-store screenshots and tests. Extract, never invent.
 */
import type {
  AccountFixture,
  ComposeDraftFixture,
  CountsFixture,
  Fixtures,
  MailboxFixture,
  MessageFixture,
  NotificationSettingsFixture,
  ReadsAiChipFixture,
  ReceiptsGroupFixture,
  ScreenedSenderFixture,
  ScreenerEmptyState,
  SearchDemoFixture,
  SpamItemFixture,
  TagFixture,
  TriageFixture,
  WaitingSenderFixture,
  WaterlineFixture,
} from "./types.js";

/* ------------------------------------------------------------ identity */

export const account: AccountFixture = {
  email: "gilles@trafficflow.ch",
  displayName: "Gilles",
};

export const mailboxes: MailboxFixture[] = [
  {
    id: "trafficflow",
    name: "trafficflow.ch",
    address: "gilles@trafficflow.ch",
    provider: "Metanet",
    protocol: "IMAP",
    railHint: "Metanet",
    status: "Connected",
  },
  {
    id: "steiner",
    name: "steiner-partner.ch",
    address: "projekt@steiner-partner.ch",
    provider: "Infomaniak",
    protocol: "IMAP",
    railHint: "Infomaniak",
    status: "Connected",
  },
  {
    id: "icloud",
    name: "iCloud",
    address: "gilles.tf@icloud.com",
    provider: "iCloud",
    protocol: "IMAP",
    railHint: "IMAP",
    status: "Connected",
  },
];

/* ---------------------------------------------------------------- tags */

export const tags: TagFixture[] = [
  {
    id: "steiner",
    name: "Projekt Steiner",
    hue: "moss",
    className: "th-steiner",
    assignedTo: ["julia", "anna"],
  },
  {
    id: "buch",
    name: "Buchhaltung",
    hue: "ochre",
    className: "th-buch",
    assignedTo: ["swisscom", "hetzner"],
  },
  {
    id: "privat",
    name: "Privat",
    hue: "rosewood",
    className: "th-privat",
    assignedTo: ["reto"],
  },
];

/** Tag ids assigned to a message id. */
export function tagsOf(messageId: string): TagFixture[] {
  return tags.filter((t) => t.assignedTo.includes(messageId));
}

/* --------------------------------------------------------------- ohbox */

export const ohbox: MessageFixture[] = [
  {
    id: "marco",
    folder: "ohbox",
    from: { name: "Marco Bianchi", address: "marco@ferrostampa.it" },
    subject: "Re: Auftragsbestätigung 4471 — Liefertermin",
    time: "09:12",
    threadCount: 4,
    unread: true,
    snippet:
      "Buongiorno Gilles, il termine di consegna si sposta al 14 agosto — va bene per voi?…",
    body: "Buongiorno Gilles,\n\nil termine di consegna si sposta al 14 agosto — va bene per voi? La produzione è già in corso; la quantità resta da confermare da parte vostra.\n\nCordiali saluti,\nMarco Bianchi\nFerrostampa S.r.l.",
    rationale:
      "Ohbox — rule: sender marco@ferrostampa.it → Ohbox (learned from you · 14×)",
    trackerNote: "1 spy pixel blocked (Mailchimp open-tracker)",
  },
  {
    id: "julia",
    folder: "ohbox",
    from: { name: "Julia Steiner", address: "j.steiner@steiner-partner.ch" },
    subject: "Vertragsentwurf v3",
    time: "08:47",
    unread: true,
    attachment: { filename: "Vertrag_v3.pdf", size: "2.4 MB" },
    snippet:
      "Anbei die überarbeitete Fassung mit den besprochenen Änderungen in §4 und §7…",
    body: "Guten Morgen Gilles\n\nAnbei die überarbeitete Fassung mit den besprochenen Änderungen in §4 und §7. Ich wäre froh um eine kurze Durchsicht bis Donnerstag.\n\nBeste Grüsse\nJulia",
    rationale: "Ohbox — rule: domain steiner-partner.ch → Ohbox",
  },
  {
    id: "github",
    folder: "ohbox",
    from: { name: "GitHub", address: "noreply@github.com" },
    subject: "Your verification code",
    time: "08:31",
    unread: true,
    protected: {
      kind: "verification",
      label: "Verification code",
      redactedNote: "(redacted)",
      policy:
        "Protected — never sent to AI, never forwarded, stored redacted. Codes live and die on your device.",
    },
    rationale: "Protected class: verification — filed by structure, content untouched",
  },
  {
    id: "david",
    folder: "ohbox",
    from: { name: "David Roth", address: "d.roth@trafficflow.ch" },
    subject: "Standup-Notizen KW31",
    time: "07:58",
    unread: true,
    snippet: "Kurz zusammengefasst: Deployment Freitag, Livio übernimmt QA…",
    body: "Kurz zusammengefasst: Deployment Freitag, Livio übernimmt QA. Der Rest steht im Board — nichts Dringendes für dich.\n\n— David",
    rationale: "Ohbox — rule: teammate @trafficflow.ch → Ohbox",
  },
  {
    id: "anna",
    folder: "ohbox",
    from: { name: "Anna Odermatt", address: "anna@odermatt-web.ch" },
    subject: "Re: Offerte Website-Relaunch",
    time: "yesterday",
    unread: false,
    body: "Besten Dank für die Offerte — wir melden uns Anfang Woche mit dem Entscheid.\n\nFreundliche Grüsse\nAnna Odermatt",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "reto",
    folder: "ohbox",
    from: { name: "Reto Frei", address: "reto.frei@bluewin.ch" },
    subject: "Foto vom Wochenende 🏔",
    time: "yesterday",
    unread: false,
    body: "Hoi Gilles — das versprochene Foto vom Grat. Nächstes Mal kommst du mit!\n\nReto",
    rationale: "Ohbox — you said Yes to this sender",
  },
];

/* --------------------------------------------------------------- reads */

export const reads: MessageFixture[] = [
  {
    id: "f1",
    folder: "reads",
    from: { name: "Dense Discovery", address: "kai@densediscovery.com" },
    subject: "#274 — on slow software and fast opinions",
    snippet: "Plus: a lamp, a typeface, and a slow-web manifesto.",
    time: "07:02",
    unread: true,
    body: "Hi there — this issue took a detour down a rabbit hole: why does every tool now ship an opinion before it ships a feature?\n\nSlow software is not software that lags. It is software that waits for you: no streaks, no nudges, no red dots begging from the home screen. This week’s essay looks at three apps that got calmer with every release — and what their changelogs quietly refused to add.\n\nWorthy five: a lamp that ages like furniture, a typeface with honest italics, a slow-web manifesto worth the twenty minutes, a pocket notebook system, and one very good broom.\n\nAlso in this issue: an interview with the maintainer of a nineteen-year-old text editor on saying no politely, and a reader thread about the last piece of software you actually finished configuring.\n\nThe archive, as always, is open — issues #1 through #273, no paywall, no tracking.\n\n— Kai",
  },
  {
    id: "f2",
    folder: "reads",
    from: { name: "Stratechery", address: "email@stratechery.com" },
    subject: "Daily Update — aggregation and the agent era",
    snippet: "What agents do to aggregation theory, in three acts.",
    time: "06:31",
    unread: true,
    body: "Act one: aggregators won by owning demand — the open web supplied, platforms distributed, and whoever held the users held the leverage.\n\nAct two: agents invert the funnel. When software does the choosing, the scarce resource is no longer attention but delegation — whose agent gets to act on your behalf, and under which defaults?\n\nAct three: the answer will look boring — contracts, rate cards, audit logs. Aggregation theory does not die in the agent era; it moves one layer down the stack.\n\nOne caveat from the mailbag: several of you pushed back on last week’s claim that defaults beat quality at scale. Fair — but the counter-examples you sent were all products whose quality WAS the default experience. That is the point.\n\nMore tomorrow, including the follow-up on the EU interoperability draft; subscribers get the audio version in the podcast app tonight.",
  },
  {
    id: "f3",
    folder: "reads",
    from: { name: "IKEA Family Neuheiten", address: "news@ikea.ch" },
    subject: "Ideen für kleine Räume",
    snippet: "Neu diese Woche: Klappbares für Balkon und Flur.",
    time: "05:44",
    unread: true,
    body: "Kleine Räume, grosse Wirkung: Diese Woche zeigen wir Neuheiten, die sich zusammenklappen, stapeln oder ganz verschwinden, wenn der Tag sie nicht braucht.\n[[img]]\nDer Klapptisch VÄSTERÖN trägt vier Teller und einen Laptop — und hängt danach flach an der Wand. Dazu: ein Hocker, der Stauraum versteckt, und Haken, die keine Löcher hinterlassen.\n\nFür IKEA Family Mitglieder diese Woche: 15% auf alle Aufbewahrungsserien — im Einrichtungshaus und online.",
    art: {
      ariaLabel: "Produktbild: Klapptisch, an der Wand montiert",
      caption: "VÄSTERÖN — klappbar, wandmontiert",
    },
  },
  {
    id: "f4",
    folder: "reads",
    from: { name: "The Pragmatic Engineer", address: "pragmaticengineer@substack.com" },
    subject: "The Pulse #104",
    snippet: "Hiring cools, platform teams warm up.",
    time: "05:12",
    unread: true,
    body: "The Pulse #104. Hiring: big-tech requisitions are flat quarter-over-quarter, but staff-plus openings quietly doubled — companies are paying for leverage, not headcount.\n\nPlatform teams are warm again: three large orgs re-centralized infra after two years of you-build-it-you-run-it fatigue. The pendulum has a schedule, and it keeps it.\n\nAlso this week: a post-mortem worth reading on a fifteen-minute global outage, and why the fix was organizational, not technical.\n\nNumbers of the week: 41% of surveyed teams now run a weekly on-call cost review, up from 12% two years ago; median incident-review length is down to forty minutes; and exactly one company in the sample still prints its architecture diagrams.\n\nFull analysis and sources below the fold.",
  },
  {
    id: "f5",
    folder: "reads",
    from: { name: "GitHub Changelog", address: "changelog@github.com" },
    subject: "Actions: faster macOS runners",
    snippet: "M-series runners are now the default for macOS builds.",
    time: "04:58",
    unread: true,
    body: "Actions: macOS builds now default to M-series runners. Median build time across our fleet dropped 38%; no workflow changes required. Intel runners remain available via runs-on labels until March.",
  },
  {
    id: "f6",
    folder: "reads",
    from: { name: "Tages-Anzeiger Briefing", address: "briefing@tages-anzeiger.ch" },
    subject: "Morgen-Briefing: Abstimmungssonntag",
    snippet: "Was heute wichtig wird — in fünf Minuten.",
    time: "04:30",
    unread: true,
    body: "Guten Morgen. Die Schweiz stimmt am Sonntag über die Prämien-Initiative ab — die letzten Umfragen sehen ein Kopf-an-Kopf-Rennen, und beide Lager mobilisieren am Wochenende noch einmal.\n\nAusserdem: Die SBB testen im Herbst durchgehende Nachtzüge nach Barcelona, Zürich diskutiert über Tempo 30 auf dem Seebecken-Ring, und im Wallis beginnt die Walnussernte so früh wie noch nie.\n\nDas Wetter: sonnig, am Nachmittag Quellwolken, 27 Grad.",
  },
  {
    id: "f7",
    folder: "reads",
    from: { name: "Figma Weekly", address: "weekly@figma.com" },
    subject: "Config recap + community files",
    snippet: "The talks worth rewatching, and one plugin.",
    time: "Mon",
    unread: true,
    body: "Config is a wrap — and the recordings are up. If you watch only three: the multiplayer-cursor deep dive, the design-systems-at-scale panel, and the twelve-minute talk on why fast software is a design decision.\n\nFrom the community: a variables migration kit, a print-ready grid file, and a plugin that lints layer names without shaming anyone.\n\nNext week: interviews from the systems track.",
  },
  {
    id: "f8",
    folder: "reads",
    from: { name: "Digitec", address: "newsletter@digitec.ch" },
    subject: "Neu eingetroffen: E-Bikes im Test",
    snippet: "Fünf Modelle, ein klarer Favorit.",
    time: "Mon",
    unread: true,
    body: "Fünf E-Bikes, vierhundert Testkilometer, ein klarer Favorit: Das leichteste Bike im Feld gewinnt — nicht wegen des Motors, sondern wegen der Bremsen.\n\nÜberzeugt hat auch der günstigste Kandidat: solide Ausstattung, ehrliche 70 km Reichweite, Schwächen nur am Display. Das teuerste Modell? Brillant — aber der Aufpreis kauft Prestige, keine Kilometer.\n\nAlle fünf Testberichte, Messwerte und das Fazit im Vergleich findest du online.\n\nAusserdem im Update: Der Winterreifen-Vergleich startet im September, und das Community-Voting für das Produkt des Jahres ist offen — 12'000 Stimmen sind schon drin.",
  },
  {
    id: "f9",
    folder: "reads",
    from: { name: "Ars Technica", address: "newsletters@arstechnica.com" },
    subject: "Rocket Report: a quiet week in launch",
    snippet: "A quiet week, except for the one that wasn’t.",
    time: "Mon",
    unread: true,
    body: "Welcome back to the Rocket Report! A quiet week in launch — which in 2026 means only nine orbital attempts, eight successes, and one very expensive lesson about pad weather holds.\n\nThe one that wasn’t quiet: a methalox upper stage relit four times on a single mission, a first for the vehicle, clearing the path for the direct-inject architecture its customers were promised.\n\nSmall-launch news: two more consolidations, one graceful, one not. The spreadsheet of active small launchers is down to eleven.\n\nElsewhere: the station handover schedule slipped a quarter, two lunar landers passed their critical design reviews in the same week, and a university cubesat photographed its own antenna failing to deploy — which is, in its way, a success for the camera team.\n\nNext week: launch windows, weather permitting, for at least six missions. We’ll believe it when the range does.",
  },
  {
    id: "f10",
    folder: "reads",
    from: { name: "Swiss Miles & More", address: "newsletter@miles-and-more.com" },
    subject: "Ihre Meilen laufen bald ab",
    snippet: "4'820 Meilen verfallen am 31. August.",
    time: "Mon",
    unread: true,
    body: "Guten Tag Gilles\n\n4'820 Meilen verfallen am 31. August. Lösen Sie Ihre Meilen jetzt ein — zum Beispiel als eVoucher, für ein Upgrade auf Ihrem nächsten Flug oder im WorldShop.\n\nIhr Miles & More Team",
  },
  {
    id: "f11",
    folder: "reads",
    from: { name: "A List Apart", address: "newsletter@alistapart.com" },
    subject: "Responsive to what, exactly?",
    snippet: "Container queries changed the question.",
    time: "Sun",
    unread: true,
    body: "For twenty years we asked what screen we were on. Container queries let components ask a better question: how much room do I actually have?\n\nThis piece walks through the refactor of a card component that shipped with nine breakpoints and came out with two container queries — and why the deleted code was the point.\n\nAlso inside: when a container query is the wrong tool, and the accessibility cost of sizing text by container width.\n\nAs always, the demos are copy-paste friendly, and the browser-support table at the end is shorter than you fear.\n\nComing next issue: anchor positioning, and why your tooltip library is about to become CSS.",
  },
  {
    id: "f12",
    folder: "reads",
    from: { name: "Craft Coffee Club", address: "hello@craftcoffee.club" },
    subject: "August roast: Kenia AA",
    snippet: "Blackcurrant, bright, dangerous before noon.",
    time: "Sun",
    unread: true,
    body: "August roast: Kenia AA, Nyeri County. Blackcurrant up front, a bright citrus acidity, and a finish that has no business being this long at this price.\n\nWe brew it at 15 g on 250 g water, 94° — and honestly, not after 15:00. It has opinions.\n\nYour bag ships Monday.",
  },
  {
    id: "f13",
    folder: "reads",
    from: { name: "Dense Discovery", address: "kai@densediscovery.com" },
    subject: "#273 — the tools we keep",
    snippet: "On software that ages well.",
    time: "Thu",
    unread: false,
    body: "On software that ages well: this issue collects tools that survived a decade without a redesign anyone noticed — and asks what they know that the rest of the industry keeps forgetting.\n\nPlus the usual worthy five, including a chair, a font, and a very good pencil sharpener.",
  },
  {
    id: "f14",
    folder: "reads",
    from: { name: "Stratechery", address: "email@stratechery.com" },
    subject: "Weekly wrap — the week in one read",
    snippet: "Everything that mattered, compressed.",
    time: "Thu",
    unread: false,
    body: "The week in one read: the agent-era essays, the interview on defaults as distribution, and Friday’s note on why audit logs are becoming a product surface.\n\nIf you read one thing, read Tuesday’s. If you read two, add the interview.",
  },
  {
    id: "f15",
    folder: "reads",
    from: { name: "IKEA Family Neuheiten", address: "news@ikea.ch" },
    subject: "Sommer-Sale endet Sonntag",
    snippet: "Letzte Chance auf Balkon-Restposten.",
    time: "Wed",
    unread: false,
    body: "Der Sommer-Sale endet Sonntag: letzte Restposten für Balkon und Garten, bis zu 50% reduziert.\n\nSolange der Vorrat reicht — online reservieren, im Einrichtungshaus abholen.",
  },
];

export const readsWaterline: WaterlineFixture = {
  afterId: "f12",
  label: "Seen up to here",
  meta: "last visit · Mon 18:40",
};

export const readsAiChip: ReadsAiChipFixture = {
  afterId: "f1",
  label: "Reads — AI 0.87: newsletter fingerprint",
  confidence: 0.87,
  reason: "newsletter fingerprint",
  approvedLabel: "Approved — saved as a rule",
  correctedLabel: "Corrected — goes to Ohbox next time",
};

/* ------------------------------------------------------------ receipts */

export const receipts: MessageFixture[] = [
  {
    id: "swisscom",
    folder: "receipts",
    from: { name: "Swisscom", address: "rechnung@swisscom.ch" },
    subject: "Rechnung Juli",
    amount: "CHF 89.00",
    snippet: "Ihre Rechnung für Juli ist bereit — zahlbar bis 15. August.",
    time: "08:20",
    unread: true,
    body: "Guten Tag\n\nIhre Rechnung für Juli 2026 ist bereit.\n\nInternet Business M — CHF 59.00\nMobile inOne M — CHF 25.00\nFestnetz-Linie — CHF 5.00\nRoaming und Optionen — CHF 0.00\n\nTotal CHF 89.00 (inkl. 8.1% MwSt.)\n\nZahlbar bis 15. August 2026. Bezahlung per LSV — der Betrag wird Ihrem Konto am Fälligkeitstag automatisch belastet.\n\nRechnungsnummer 105 884 221\nKundennummer 62 337 810\n\nDie detaillierte Verbindungsübersicht finden Sie im Kundencenter unter «Rechnungen».",
  },
  {
    id: "sbb",
    folder: "receipts",
    from: { name: "SBB", address: "tickets@sbb.ch" },
    subject: "Ihr Billett Zürich–Bern",
    snippet: "Zürich HB ab 08:02, Gleis 32 — gute Reise.",
    time: "Mon",
    unread: true,
    body: "Zürich HB → Bern\nMo 28. Juli · Abfahrt 08:02, Gleis 32 · Ankunft 08:58\n\n1 × 2. Klasse, Halbtax — CHF 26.00\nBezahlt mit TWINT.\n\nDas Billett ist in der App hinterlegt und wird bei der Kontrolle direkt gescannt.",
  },
  {
    id: "hetzner",
    folder: "receipts",
    from: { name: "Hetzner", address: "invoice@hetzner.com" },
    subject: "Invoice #2026-44821",
    amount: "€4.51",
    snippet: "Amount due €4.51 — paid with the card on file.",
    time: "Mon",
    unread: true,
    body: "Invoice #2026-44821 — July 2026\n\nCloud Server CX22 (fsn1), 01–31 Jul — €3.92\nBackups (20%) — €0.59\n\nTotal €4.51 (incl. VAT)\n\nPaid with Visa ···· 4821 on file. No action required — this is your receipt.",
  },
];

export const receiptsGroups: ReceiptsGroupFixture[] = [
  { label: "Today", items: ["swisscom"] },
  { label: "Monday", items: ["sbb", "hetzner"] },
];

/* ------------------------------------------------------------ screener */

export const waiting: WaitingSenderFixture[] = [
  {
    id: "lena",
    from: { name: "Lena Kaufmann", address: "lena@atelier-nord.ch" },
    initial: "L",
    time: "08:40",
    scope: "sender",
    ai: {
      dest: "ohbox",
      confidence: 0.92,
      rationale: "personal message, real sender, no bulk fingerprint",
    },
    held: [
      {
        subject: "Werkstatt-Termin nächste Woche?",
        time: "08:12",
        body: "Hallo Gilles\n\nWir haben uns letzten Monat am Handwerksmarkt in Winterthur kurz unterhalten — ich hatte den Stand mit den Eichenmöbeln, Sie haben mir von Ihrer Arbeit an trafficflow erzählt. Ihre Karte liegt seither auf meiner Werkbank, und jetzt komme ich endlich dazu, mich zu melden.\n\nHätten Sie nächste Woche Zeit für eine Besichtigung in der Werkstatt? Es geht um den Empfangstisch, von dem wir gesprochen haben — ich hätte Dienstag oder Donnerstag Nachmittag frei. Passt Ihnen einer der beiden Termine?\n\nHerzliche Grüsse aus Winterthur\nLena Kaufmann\nAtelier Nord",
      },
      {
        subject: "Kleine Ergänzung",
        time: "08:40",
        body: "Nochmals kurz: Falls es nächste Woche nicht klappt, wäre auch der Freitag darauf möglich. Und bringen Sie gerne die Skizzen mit, die Sie erwähnt hatten.\n\nLena",
      },
    ],
  },
  {
    id: "notion",
    from: { name: "Notion Team", address: "team@mail.notion.so" },
    initial: "N",
    time: "07:26",
    scope: "sender",
    ai: {
      dest: "reads",
      confidence: 0.88,
      rationale: "newsletter fingerprint: List-Unsubscribe, bulk precedence",
    },
    held: [
      {
        subject: "Welcome to your new workspace",
        time: "07:26",
        body: "Hi Gilles,\n\nYour workspace is ready. Here are the three things most new members do in their first week:\n\n1. Import your notes — Evernote, Markdown or plain text; everything keeps its structure.\n2. Invite your team — pages become shared the moment a second person joins.\n3. Try a database — start from the Projects template and change one property. That is usually the moment it clicks.\n\nA quiet tip: press Cmd+K anywhere. Nearly everything in Notion is reachable from that one box.\n\nWe send one onboarding mail per week for the next three weeks — you can end the series with one click below.\n\n— The Notion Team",
      },
    ],
  },
  {
    id: "lotto",
    from: { name: "SwissLotto Promo", address: "win@lotto-alerts.info" },
    initial: "S",
    time: "06:58",
    scope: "domain",
    dull: true,
    ai: {
      dest: "screened",
      confidence: 0.97,
      rationale: "promo blast, link-tracker dense, unknown domain",
    },
    held: [
      {
        subject: "🎰 Sie haben 3 Freispiele gewonnen!",
        time: "06:58",
        trackerNote: "31 tracking links · 2 spy pixels blocked",
        body: "GLÜCKWUNSCH!!! Ihre E-Mail wurde ausgewählt: 3 FREISPIELE + 200% Bonus warten auf Sie.\n\n>> JETZT EINLÖSEN — nur 24 Stunden gültig <<\n\nÜber 9'000 Gewinner diese Woche. Verpassen Sie nicht Ihre Chance auf den Jackpot von CHF 1'750'000.\n\nKlicken Sie hier • Bonus aktivieren • Jetzt spielen\n\nSie erhalten diese Mail, weil Sie sich für Partnerangebote registriert haben. Abmelden.",
      },
    ],
  },
];

export const screenedOut: ScreenedSenderFixture[] = [
  {
    address: "promo@fashion-deals.ch",
    screenedOn: "12 Jul",
    heldCount: 8,
    lastSubject: "Mid-Season Sale: bis 70% auf alles",
    lastBody:
      "Nur dieses Wochenende: bis 70% auf über 4'000 Artikel.\n\nSneaker ab CHF 29.90 • Jacken ab CHF 49.90 • Accessoires ab CHF 9.90\n\nGratisversand ab CHF 50 — Code WEEKEND70 an der Kasse.",
  },
  {
    address: "notifications@old-forum.net",
    screenedOn: "3 Jun",
    heldCount: 2,
    lastSubject: "3 neue Antworten in „Router-Konfiguration“",
    lastBody:
      "Es gibt 3 neue Antworten in einem Thema, dem du folgst: „Router-Konfiguration VDSL“.\n\nDu erhältst diese Benachrichtigung, weil du das Thema 2019 abonniert hast. Benachrichtigungen lassen sich im Profil verwalten.",
  },
];

export const spam: SpamItemFixture[] = [
  {
    from: "crypto-bonus@win-invest.biz",
    subject: "Ihr Bitcoin Gewinn wartet 🎁",
    detection: {
      source: "auto-detected",
      confidence: 0.98,
      reason: "phishing fingerprint",
      label: "auto-detected · 0.98 · phishing fingerprint",
    },
    time: "Tue",
    trackerNote: "12 tracking links blocked",
    body: "Sehr geehrter Kunde,\n\nIhr Konto zeigt einen nicht abgeholten Gewinn von 0.4 BTC. Bestätigen Sie Ihre Wallet-Adresse innert 48 Stunden, sonst verfällt der Betrag.\n\nJetzt bestätigen → wallet-verify-ch.win-invest.biz\n\nSupport Team",
  },
  {
    from: "support@paypa1-secure.info",
    subject: "Ihr Konto wurde eingeschränkt",
    detection: {
      source: "auto-detected",
      confidence: 0.96,
      reason: "lookalike domain (paypa1)",
      label: "auto-detected · 0.96 · lookalike domain (paypa1)",
    },
    time: "Mon",
    trackerNote: "lookalike link flagged: paypa1-secure.info",
    body: "Ihr Konto wurde vorübergehend eingeschränkt. Um die Einschränkung aufzuheben, bestätigen Sie Ihre Daten über den folgenden Link.\n\nKonto bestätigen → secure.paypa1-secure.info/login\n\nDieser Vorgang dauert nur 2 Minuten.",
  },
];

export const screenerEmptyStates: Record<
  "waiting" | "screened" | "spam",
  ScreenerEmptyState
> = {
  waiting: {
    glyph: "🕊",
    title: "No one’s waiting.",
    hint: "First-time senders appear here before anything reaches the Ohbox.",
  },
  screened: {
    glyph: "🚪",
    title: "No senders screened out.",
    hint: "Screening out a waiting sender lists them here — reversible any time.",
  },
  spam: {
    glyph: "🕳",
    title: "No spam held.",
    hint: "Auto-detected spam lands here for review — nothing is deleted unseen.",
  },
};

/* -------------------------------------------------------------- triage */

export const triage: TriageFixture = {
  replyLater: [
    {
      messageId: "marco",
      title: "Marco Bianchi",
      subtitle: "Re: Auftragsbestätigung 4471 — Liefertermin",
      preview:
        "Buongiorno Gilles, il termine di consegna si sposta al 14 agosto — va bene per voi?…",
    },
    {
      messageId: "julia",
      title: "Julia Steiner",
      subtitle: "Vertragsentwurf v3",
      preview:
        "Anbei die überarbeitete Fassung mit den besprochenen Änderungen in §4 und §7…",
    },
  ],
  setAside: [{ title: "Swiss", subtitle: "Itinerary ZRH→LIS, 12 Aug" }],
  resurface: [{ title: "Domain renewal trafficflow.ch", resurfaceAt: "Fri 09:00" }],
};

/* -------------------------------------------------------------- search */

export const search: SearchDemoFixture = {
  query: "invoce",
  resultCount: 2,
  tookMs: 11,
  source: "local index",
  hits: [
    {
      who: "Marco Bianchi",
      where: "Ohbox · 09:12",
      subject: "Re: Auftragsbestätigung 4471 — Liefertermin",
      fuzzyNote: "fuzzy match — “invoice”",
    },
    {
      who: "Hetzner",
      where: "Receipts · Tue",
      subject: "Invoice #2026-44821 — €4.51",
      highlight: "Invoice",
    },
  ],
  facets: [
    {
      title: "From",
      items: [
        { label: "Marco", count: 3 },
        { label: "Hetzner", count: 2 },
      ],
    },
    { title: "Folder", items: [{ label: "Ohbox" }, { label: "Receipts" }] },
    { title: "Refine", items: [{ label: "Has attachment" }] },
    { title: "Date", items: [{ label: "This week" }, { label: "July" }] },
  ],
  emptyTitle: "No local results.",
  emptyHint: "Press ↵ to search the server archive.",
};

/* ------------------------------------------------------------- compose */

export const composeDraft: ComposeDraftFixture = {
  to: { name: "Marco Bianchi", address: "marco@ferrostampa.it" },
  subject: "Re: Auftragsbestätigung 4471 — Liefertermin",
  tagLabel: "AI draft — not sent",
  body: "Buongiorno Marco, il 14 agosto va benissimo — grazie per l’avviso. Può confermare che la quantità resta invariata (1'200 pz)? Cordiali saluti, Gilles",
  grounding:
    "Drafted from your 14 previous replies to Marco + KB: “Lieferzeiten Standardantwort”",
  editorPlaceholder: "Write your message, or take the draft above.",
  sendNote: "Draft — not sent",
};

/* ------------------------------------------------------------ settings */

export const notificationSettings: NotificationSettingsFixture = {
  channels: [
    {
      id: "people",
      label: "People in Ohbox",
      description: "Mail from people you said Yes to",
      enabled: true,
    },
    {
      id: "known",
      label: "Known senders",
      description: "Anyone your rules already file",
      enabled: true,
    },
    { id: "reads", label: "Reads", description: "New newsletter issues", enabled: false },
    {
      id: "receipts",
      label: "Receipts",
      description: "Orders, invoices, tickets",
      enabled: false,
    },
    {
      id: "screener",
      label: "Screener holds",
      description: "Weekly digest instead of alerts",
      enabled: false,
    },
  ],
  vipLabel: "VIP — always notifies",
  vips: ["Julia Steiner", "Marco Bianchi"],
  learnedSuggestion: {
    text: "You usually open Julia’s mail within 5 minutes — add to VIP?",
    target: "Julia Steiner",
    acceptedToast: "Julia Steiner added to VIP.",
    dismissedToast: "Dismissed — no more suggestions for Julia.",
  },
  privacyNote: "Notifications carry no mail content — your device fetches privately.",
};

/* -------------------------------------------------------------- counts */

export const counts: CountsFixture = {
  ohboxUnread: 4,
  ohboxTotal: 9,
  reads: 12,
  receipts: 7,
  screenerWaiting: 3,
  replyLater: 2,
  setAside: 1,
  resurface: 1,
};

/* ----------------------------------------------------------- the world */

export function getFixtures(): Fixtures {
  return {
    account,
    mailboxes,
    tags,
    ohbox,
    reads,
    readsWaterline,
    readsAiChip,
    receipts,
    receiptsGroups,
    screener: {
      waiting,
      screenedOut,
      spam,
      emptyStates: screenerEmptyStates,
    },
    triage,
    search,
    composeDraft,
    notificationSettings,
    counts,
  };
}
