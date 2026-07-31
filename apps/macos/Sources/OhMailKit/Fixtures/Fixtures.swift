import Foundation

/// Mila's world — the fictional demo persona, extracted from the Blanc prototype
/// (`design/proposals/blanc/index.html`).
///
/// PRIVACY INVARIANT (#6): zero real personal data, zero real brands. Every
/// sender, address and brand below is invented for Mila and listed in
/// `fictionalNames` with the reason it is safe. `OhMailKitTests` audits the whole
/// corpus — every field, every held message at every depth — against
/// `bannedTerms`, and additionally asserts that every display name the app can
/// render appears in the registry, so a new sender cannot be added without review.
///
/// NO-COLLAPSE RULE (#6): every message is a real, fully-rendered fixture. There
/// are no "N more" / "N archived" / "newest of N" placeholders in this file or in
/// any view that reads it — screener records carry a `HeldMailbag`, and a
/// conversation carries every message behind its thread badge.
public enum Fixtures {

    // MARK: Account

    public static let ownerAddress = "mila@lichtgrat.studio"

    public static func mailboxesRail() -> [MailboxAccount] { mailboxes() }

    public static func mailboxes() -> [MailboxAccount] {
        [
            MailboxAccount(address: "mila@lichtgrat.studio", kind: "Work · IMAP", shortName: "lichtgrat.studio"),
            MailboxAccount(address: "hello@milabrunner.ch", kind: "Personal · IMAP", shortName: "milabrunner.ch"),
            MailboxAccount(address: "mila.demo@wolkenmail.ch", kind: "Wolkenmail · IMAP", shortName: "Wolkenmail"),
        ]
    }

    // MARK: - The reviewed fictional-name registry
    //
    // Adding a sender means adding a line here, which is the review step. The
    // audit test fails on any renderable display name that is missing, on any
    // entry whose note is empty, and on any `.nearCollision` that does not name
    // the real entity it collided with.
    //
    // This is the web mirror of `fictionalNames` / `bannedTerms` in
    // `packages/fixtures/src/privacy.ts` — the two must stay in step, because the
    // same persona ships on both surfaces. Read that file's header for the full
    // rationale; the short version is below.
    //
    // WHAT THIS COST TO LEARN. The first pass of this registry certified nine
    // names as coined that were live brands, among them the persona's own mail
    // domain (a real studio's registered domain), the security sender the
    // phishing demo impersonates (a real security company), and the flat-pack
    // retailer (a real furniture label). Every one read plausibly coined. Hence
    // the verdict below: prose alone was not falsifiable, so it was not enough.

    /// The claim a registry entry is willing to make about its name.
    public enum NameVerdict: String, Sendable {
        /// A search for the name turned up no operating entity.
        case coined
        /// Real entities DO share the name; `collision` names them, reuse accepted.
        case nearCollision
        /// Ordinary words in ordinary use — no distinctive mark claimed or at risk.
        case descriptive
        /// A person's name, invented, no public figure.
        case inventedPerson
    }

    public struct FictionalName: Sendable {
        public let name: String
        /// The reviewed claim. `.nearCollision` REQUIRES `collision`.
        public let verdict: NameVerdict
        /// Why this name is safe to ship in a public demo.
        public let note: String
        /// For `.nearCollision` only: the real entity/entities found in review,
        /// named explicitly, so an entry can never imply "nothing matched" when
        /// something did.
        public let collision: String?
        public init(_ name: String, _ verdict: NameVerdict, _ note: String, collision: String? = nil) {
            self.name = name; self.verdict = verdict; self.note = note; self.collision = collision
        }
    }

    /// Every person, brand and organisation name the demo can put on screen.
    ///
    /// Notes deliberately do NOT spell out the real brands that were removed —
    /// those strings are in `bannedTerms`, the notes are audited as corpus, and a
    /// real brand named in a comment is still a real brand in this repository.
    public static let fictionalNames: [FictionalName] = [
        // People — invented, Swiss/Italian/German-plausible, no public figures.
        .init("Mila Brunner", .inventedPerson, "the demo persona; invented"),
        .init("Giulia Ferrari", .inventedPerson, "invented; common given + surname, no public figure"),
        .init("Petra Wyss", .inventedPerson, "invented"),
        .init("Ben Arnold", .inventedPerson, "invented"),
        .init("Anna Odermatt", .inventedPerson, "invented"),
        .init("Reto Frei", .inventedPerson, "invented"),
        .init("Flurina Caduff", .inventedPerson, "invented"),
        .init("Tim Berger", .inventedPerson, "invented"),
        .init("Carla Meier", .inventedPerson, "invented"),
        .init("Lena Kaufmann", .inventedPerson, "invented"),
        .init("Mara Lehner", .inventedPerson, "invented; the Skylark Notes author signature"),

        // Brands.
        .init("Lichtgrat Studio", .coined,
              "Mila's own studio (Licht + Grat, two words German does not compound); replaces a name whose domain was a real design agency's live domain — and it was the persona's own address, so it was on screen constantly"),
        .init("Wolkenmail", .coined, "mail provider (Wolke = cloud); no operating entity found"),
        .init("Terracotta Milano", .descriptive,
              "pottery supplier; two ordinary Italian words (the material + the city), so no distinctive mark is claimed",
              collision: "generic use is everywhere in Italian ceramics (e.g. the CottoMilano tile line, terracottaitalia.com); none is a mark this reuses"),
        .init("Makersfest", .coined, "conference; no operating entity found"),
        .init("Cinderlock", .coined,
              "the protected-class verification sender; replaces a name that was a real security company's — which the phishing demo below was busy impersonating",
              collision: "a World of Warcraft player character uses the word; a character handle is not a mark"),
        .init("Gartenlokal Rosa", .coined, "restaurant; no operating entity found"),
        .init("Haldenlicht", .coined,
              "workshop host (Halde + Licht); replaces a name registered by several real companies"),
        .init("Gassenblatt", .coined,
              "neighbourhood paper; replaces a name that was a real Swiss neighbourhood paper — same word, same country, same trade"),
        .init("Sommerfest Lind", .coined, "street party; no operating entity found"),
        .init("Alpmail", .coined, "mail provider; no operating entity found"),
        .init("Skylark Notes", .coined, "newsletter; no operating entity found"),
        .init("Blattgang", .coined,
              "newsletter (Blatt + Gang); replaces a name carried by a real reading app and a real security newsletter"),
        .init("Wohnfalz", .coined,
              "furniture retailer, the flat-pack-catalogue stand-in (Wohn + Falz, the woodworking rabbet); replaces a name that was a real furniture design label in exactly this trade"),
        .init("KLAPPRI", .coined,
              "the folding-table product inside the Wohnfalz issue; replaces a name carried by two real furniture makers"),
        .init("The Maker’s Dozen", .coined, "newsletter; no operating entity found"),
        .init("Gratbrief", .coined,
              "hiking newsletter (Grat = ridge); replaces a name that collided with a real product"),
        .init("Frühbrief Briefing", .coined,
              "morning briefing (früh + Brief); replaces a name that is a real German newspaper masthead in three cities"),
        .init("Brandung Records", .coined, "label; no operating entity found"),
        .init("Nordwind Outdoor", .nearCollision,
              "outdoor retailer; the qualifier puts it in a different trade from everything found, and Nordwind is an ordinary German word (north wind)",
              collision: "Nordwind Records and the Nordwind Festival (Berlin) both operate under the bare word; neither sells outdoor kit"),
        .init("Comet Courier", .nearCollision,
              "astronomy newsletter; near-collision reviewed and accepted — the twin is a non-commercial school publication with no mark to reuse",
              collision: "the Comet Courier, a US elementary-school newsletter (Horizon Elementary, Loudoun County)"),
        .init("Bergbahn Club", .coined, "mountain-railway club; no operating entity found"),
        .init("Pixel & Thread", .coined, "textile/design newsletter; no operating entity found"),
        .init("Röstsonntag", .coined,
              "coffee roaster; replaces a name that collided with a real roaster"),
        .init("Open-Air Kino Seeblick", .coined, "open-air cinema; no operating entity found"),
        .init("Atelier Erdton", .coined, "pottery studio (Erdton = earth tone); no operating entity found"),
        .init("Speichenhof Velos", .coined,
              "bike shop (Speichen + Hof); replaces a name that was a real Swiss bike shop's — same word, same country, same trade"),
        .init("Alpenbahn", .descriptive,
              "rail operator; the ordinary German term for an alpine railway, used generically, not as anyone's mark",
              collision: "used descriptively across Swiss and Austrian rail tourism; no single operator owns it"),
        .init("Pigment & Papier", .coined, "art-supply shop; no operating entity found"),
        .init("Atelier Eichspan", .coined,
              "woodworking studio (Eiche + Span, fitting Lena's oak furniture); replaces a name that is a real art institution's"),
        .init("Paperbird", .nearCollision,
              "note-taking app; near-collision reviewed and accepted — neither twin is mail- or notes-adjacent, so the coined usage stands",
              collision: "paperbird.us, a Boston paper-goods and invitations business, and a “Paper Bird” Android app"),
        .init("JackpotJodel Promo", .coined, "promo blast (the spam-grade sender); no operating entity found"),
        .init("Fashion Deals", .descriptive,
              "retailer, screened out; two generic retail words chosen precisely because they read as bulk filler, not as a brand"),
        .init("Old Forum", .descriptive,
              "forum, screened out; generic words standing in for any stale mailing list"),
        .init("Win-Invest", .coined, "phishing sender; no operating entity found"),
        .init("Cinderl0ck Secure", .coined,
              "the phishing demo — a zero-for-o lookalike of the coined Cinderlock, so the impersonated brand is fictional too"),
    ]

    /// Substrings that must never appear anywhere in the FIXTURE CORPUS: the
    /// owner's real identity, the real company, and every real brand identified in
    /// review — including the nine this registry once certified as coined.
    ///
    /// SCOPE. This list governs the demo world: fixtures, and the review notes
    /// above (audited as corpus, so a note may never name a brand it bans). It is
    /// not a repo-wide grep, and one product string deliberately contradicts it —
    /// see `namespaceExemption`.
    public static let bannedTerms: [String] = [
        // real personal / company identity
        "gilles", "goetsch", "trafficflow", "steiner",
        // real brands previously present or adjacent enough to guard
        "alpenglow", "trailhead", "ikea", "swisscom", "sbb", "migros", "coop",
        "nespresso", "starbucks", "salesforce", "hetzner", "github", "notion",
        "icloud", "gmail", "outlook", "protonmail", "fastmail", "superhuman", "hey.com",
        // real brands this registry itself once shipped as "coined" — banned so the
        // same nine names cannot walk back in behind a plausible-looking note
        "hejmo", "falto", "northlight", "skyfort", "skyf0rt", "atelier nord",
        "atelier-nord", "morgenpost", "looseleaf", "velowerk", "bergwind",
        "quartierpost",
    ]

    /// The one documented contradiction of `bannedTerms`, kept honest on purpose.
    ///
    /// The IMAP folder namespace used to be the contradiction: the product
    /// created `TrafficFlow/…` folders inside real customer mailboxes. That is
    /// fixed — on 2026-07-31, with zero real mailboxes connected, the five
    /// strings became `ohmail/Screener`, `ohmail/Reads`, `ohmail/Receipts`,
    /// `ohmail/Screened`, `ohmail/Quarantine`. Nothing a user can see carries
    /// the pre-rebrand name any more.
    ///
    /// What survives is the backend workspace scope — `@trafficflow/{api,core,
    /// db,services}` and `@trafficflow/worker`. Nothing is published, and the
    /// specifiers are resolved away at build time, so the term appears in no
    /// bundle, no payload and no mailbox. Mirrors `NAMESPACE_EXEMPTION` in
    /// `privacy.ts`.
    ///
    /// The view rule stands regardless: never render a raw folder string; map
    /// it, and fall back to the leaf segment, never the full path.
    public static let namespaceExemption = (
        term: "trafficflow",
        site: "backend workspace package scope @trafficflow/{api,core,db,services,worker}",
        until: "a future workspace-scope rename; the user-visible folder namespace is already ohmail/…"
    )

    // MARK: Tags (cross-cutting)

    public static func tags() -> [String: [TagID]] {
        [
            "giulia": [.pottery], "flurina": [.pottery],
            "erdton": [.buch], "pigment": [.buch],
            "reto": [.privat], "tim": [.privat],
        ]
    }

    // MARK: Ohbox — 9 rows (4 unread + 5 seen)

    public static func ohbox() -> [Message] {
        [
            // A four-message thread: the badge says 4 and all four are rendered.
            Message(id: "giulia", place: .ohbox, from: "Giulia Ferrari", addr: "giulia@terracotta-milano.it",
                    subj: "Re: Glaze order #2214 — arriving early 🎉", time: "09:12", unread: true,
                    preview: "Buongiorno Mila, buone notizie — la spedizione arriva già il 4 agosto…",
                    body: "Buongiorno Mila,\n\nbuone notizie — la vostra spedizione di smalti arriva già il 4 agosto, dieci giorni prima del previsto! Verde salvia e bianco opaco sono entrambi in cartone.\n\nMi confermate che la consegna resta all’atelier?\n\nA presto,\nGiulia Ferrari\nTerracotta Milano",
                    earlier: [
                        HeldMail(id: "giulia-1", subj: "Glaze order #2214 — confermato", time: "Thu 11:04",
                                 body: "Buongiorno Mila,\n\nordine #2214 registrato: verde salvia 5 kg, bianco opaco 5 kg. Vi scrivo appena la fornace del nostro fornitore libera il lotto.\n\nGiulia"),
                        HeldMail(id: "giulia-2", subj: "Re: Glaze order #2214 — i colori", time: "Fri 09:20",
                                 body: "Piccola nota sui colori: il verde salvia di questo lotto è un soffio più freddo del precedente. Bellissimo sul gres chiaro, un po’ più severo sul rosso.\n\nVi mando due tessere di prova con la spedizione.\n\nGiulia"),
                        HeldMail(id: "giulia-3", subj: "Re: Glaze order #2214 — imballato", time: "Mon 16:47",
                                 body: "Tutto imballato oggi: due cartoni, doppio strato, le tessere di prova nel primo.\n\nAppena ho la data di partenza ve la scrivo subito.\n\nGiulia"),
                    ],
                    rationale: "Ohbox — rule: sender giulia@terracotta-milano.it → Ohbox (learned from you · 14×)",
                    tracker: "1 spy pixel blocked (open-tracker)"),
            Message(id: "petra", place: .ohbox, from: "Petra Wyss", addr: "petra@makersfest.ch",
                    subj: "Your talk is in! 🎈", time: "08:47", unread: true,
                    preview: "Great news — “Wabi-sabi for web people” made the final program…",
                    body: "Hi Mila\n\nGreat news — “Wabi-sabi for web people” made the final program! You’re on Saturday at 11:00 in the main hall; yours was one of the most requested sessions.\n\nSpeaker details attached — and yes, there is a speaker dinner on Friday.\n\nSee you in September!\nPetra",
                    rationale: "Ohbox — rule: domain makersfest.ch → Ohbox",
                    attach: "Speaker_Info.pdf (1.2 MB)"),
            // Protected class: built through the `protected` factory, which has no
            // body or preview parameter — the plaintext cannot exist.
            Message.protected(id: "cinderlock", place: .ohbox, from: "Cinderlock", addr: "no-reply@cinderlock.app",
                              subj: "Your verification code", time: "08:31", unread: true),
            Message(id: "ben", place: .ohbox, from: "Ben Arnold", addr: "ben@lichtgrat.studio",
                    subj: "Kiln’s fixed + Friday pizza 🍕", time: "07:58", unread: true,
                    preview: "Good news twice: the kiln heats evenly again, and Friday we fire the wood oven…",
                    body: "Good news twice: the kiln heats evenly again — the new element arrived early — and Friday we fire the wood oven after work. Bring nothing but appetite.\n\n— Ben",
                    rationale: "Ohbox — rule: teammate @lichtgrat.studio → Ohbox"),
            Message(id: "anna", place: .ohbox, from: "Anna Odermatt", addr: "anna@gartenlokal-rosa.ch",
                    subj: "Re: the new menu cards — wow!", time: "yesterday", seen: true,
                    body: "The cards arrived and they’re even lovelier in person — guests keep picking them up and turning them over. Thank you for making us look this good!\n\nWarmly,\nAnna",
                    rationale: "Ohbox — you said Yes to this sender"),
            Message(id: "reto", place: .ohbox, from: "Reto Frei", addr: "reto@alpmail.ch",
                    subj: "Fotos vom Grat 🏔", time: "yesterday", seen: true,
                    body: "Hoi Mila — die versprochenen Fotos vom Grat. Der Sonnenaufgang war jede Minute um 4 Uhr wert. Nächstes Mal kommst du mit!\n\nReto",
                    rationale: "Ohbox — you said Yes to this sender"),
            Message(id: "flurina", place: .ohbox, from: "Flurina Caduff", addr: "flurina@haldenlicht.ch",
                    subj: "Saturday’s workshop is full! 🙌", time: "yesterday", seen: true,
                    body: "All twelve spots are booked — and two people already asked about a second date. Shall we plan an autumn edition?\n\nFlurina",
                    rationale: "Ohbox — you said Yes to this sender"),
            Message(id: "tim", place: .ohbox, from: "Tim Berger", addr: "tim@gassenblatt.ch",
                    subj: "Got us tickets for the 22nd! 🎶", time: "Mon", seen: true,
                    body: "Row 8, right side — close enough to see the drummer sweat. I’ll forward the details; you owe me a beer.\n\nTim",
                    rationale: "Ohbox — you said Yes to this sender"),
            Message(id: "carla", place: .ohbox, from: "Carla Meier", addr: "carla@sommerfest-lind.ch",
                    subj: "The posters were a hit — danke!", time: "Mon", seen: true,
                    body: "Half the neighbourhood asked who made them. See you at the fest on Saturday — we saved you a raclette.\n\nCarla",
                    rationale: "Ohbox — you said Yes to this sender"),
        ]
    }

    // MARK: Reads — 15 (12 unread + 3 seen)

    public static let readsWaterline = "last visit · Mon 18:40"

    public static func reads() -> [Message] {
        func m(_ id: String, _ from: String, _ addr: String, _ subj: String, _ prev: String, _ time: String, unread: Bool) -> Message {
            Message(id: id, place: .reads, from: from, addr: addr, subj: subj, time: time, unread: unread, seen: !unread, preview: prev)
        }
        return [
            m("f1", "Skylark Notes", "mara@skylarknotes.com", "#118 — the joy of small tools", "Plus: a lamp, a ladle, and one very good pencil.", "07:02", unread: true),
            m("f2", "Blattgang", "post@blattgang.press", "Why paper keeps winning", "Three hundred years of interface design, still undefeated.", "06:31", unread: true),
            m("f3", "Wohnfalz", "news@wohnfalz.ch", "Ideen für kleine Räume", "Neu diese Woche: Klappbares für Balkon und Flur.", "05:44", unread: true),
            m("f4", "The Maker’s Dozen", "hello@makersdozen.studio", "#41 — twelve things makers loved", "A kiln timer, a broom, and a very honest pricing essay.", "05:12", unread: true),
            m("f5", "Gratbrief", "post@gratbrief.ch", "This week’s hike: the Chäserrugg ridge", "Four hours, one ridge, zero regrets.", "04:58", unread: true),
            m("f6", "Frühbrief Briefing", "briefing@fruehbrief.ch", "Morgen-Briefing: Sommerfest-Wochenende", "Was heute schön wird — in fünf Minuten.", "04:30", unread: true),
            m("f7", "Brandung Records", "post@brandung-records.de", "New signings + Sommernacht lineup 🎶", "Two new bands, one lake stage, all summer.", "Mon", unread: true),
            m("f8", "Nordwind Outdoor", "news@nordwind-outdoor.ch", "Fünf Zelte im Test", "Fünf Modelle, ein klarer Favorit.", "Mon", unread: true),
            m("f9", "Comet Courier", "mail@cometcourier.space", "A very good week above the clouds", "Meteor showers, a comet with a schedule, and one happy telescope.", "Mon", unread: true),
            m("f10", "Bergbahn Club", "club@bergbahnclub.ch", "Dein Sommerpass ist aktiv 🚠", "Alle 23 Bahnen, den ganzen August — los geht’s.", "Mon", unread: true),
            m("f11", "Pixel & Thread", "letter@pixelthread.studio", "Weaving color into everything", "A dye garden, a palette tool, and one brave kitchen.", "Sun", unread: true),
            m("f12", "Röstsonntag", "hallo@roestsonntag.ch", "August roast: Kenya AA", "Blackcurrant, bright, dangerous before noon.", "Sun", unread: true),
            m("f13", "Skylark Notes", "mara@skylarknotes.com", "#117 — the tools we keep", "On objects that age well.", "Thu", unread: false),
            m("f14", "Blattgang", "post@blattgang.press", "Weekly wrap — the week in one read", "Everything lovely, compressed.", "Thu", unread: false),
            m("f15", "Wohnfalz", "news@wohnfalz.ch", "Sommer-Sale endet Sonntag", "Letzte Chance auf Balkon-Lieblinge.", "Wed", unread: false),
        ]
    }

    /// Invented newsletter bodies so the skim stream feels real.
    /// `MailContent.imageMarker` splits a body around the inline product-image
    /// placeholder (rendered as a figure).
    public static let readsArtCaption = "KLAPPRI — klappbar, wandmontiert"

    public static func readsBodies() -> [String: String] {
        [
            "f1": "Hi there — this issue is a love letter to tools that do one thing kindly.\n\nSmall tools are not lesser tools. They are the ones that fit your hand on the first try: the ladle that pours without dripping, the pencil that starts every list, the app with exactly one screen. This week’s essay visits three workshops and asks each maker which object they’d save from a fire. Nobody picked the expensive one.\n\nWorthy five: a lamp that ages like furniture, a wooden ladle from a two-person workshop, a pencil with honest graphite, a pocket notebook system, and one very good broom.\n\nAlso in this issue: an interview with a bookbinder on the pleasure of doing the same thing ten thousand times, and a reader thread about the tool you’ve owned longest.\n\nThe archive, as always, is open — issues #1 through #117, no paywall, no tracking.\n\n— Mara Lehner",
            "f2": "Three hundred years after the broadsheet, paper is still the best interface anyone has shipped: instant on, folds to pocket size, survives coffee, works in sunlight.\n\nThis week’s essay is about why the good digital tools all quietly imitate it — margins, pages, bookmarks, the satisfying flip — and what they still haven’t managed to copy. (Hint: it’s the smell, but it’s also the permission to scribble.)\n\nFrom the mailbag: a dozen of you sent photos of your reading chairs. They are all magnificent. The armchair-with-lamp configuration leads by a wide margin.\n\nNext week: a visit to a paper mill that has been run by the same family since 1874, and what their apprentice learned in year one. (Everything. She learned everything.)",
            "f3": "Kleine Räume, grosse Wirkung: Diese Woche zeigen wir Neuheiten, die sich zusammenklappen, stapeln oder ganz verschwinden, wenn der Tag sie nicht braucht.\n\(MailContent.imageMarker)\nDer Klapptisch KLAPPRI trägt vier Teller und einen Laptop — und hängt danach flach an der Wand. Dazu: ein Hocker, der Stauraum versteckt, und Haken, die keine Löcher hinterlassen.\n\nFür Wohnfalz Mitglieder diese Woche: 15% auf alle Aufbewahrungsserien — im Showroom und online.",
            "f4": "Twelve things makers loved this month, and this one is a good batch.\n\nThe kiln timer that finally does ramps properly. A broom (yes, a second good broom this year — it’s a golden age). A price-your-work essay written by a potter who doubled her prices and lost exactly zero customers — required reading before your next market.\n\nAlso in the dozen: linen aprons that survive the wheel, a glaze-test tile system that ends the guessing, and a folding market table that one person can carry uphill.\n\nThe community thread this month: what did you make for yourself, not for sale? The answers are wonderful. A gate hinge. A soup bowl. A banjo.\n\nFull list with photos and links below.",
            "f5": "This week’s hike: the Chäserrugg ridge. Four hours, one ridge line, and the kind of views that make you forgive the first forty minutes of forest switchbacks.\n\nGo early — the light on the Churfirsten before nine is the whole point. Coffee at the top station is honest; the rösti is better. Boots over trail runners: the ridge path has opinions.\n\nNext week: a lake-to-lake traverse with a swim in the middle.",
            "f6": "Guten Morgen. Das Sommerfest-Wochenende steht vor der Tür — in Winterthur werden über vierzig Quartierfeste erwartet, und die Wetterprognose spielt mit.\n\nAusserdem: Die Nachtzug-Teststrecke nach Barcelona ist auf den Herbst bestätigt, die Badis melden die wärmsten Wassertemperaturen seit fünf Jahren, und im Wallis beginnt die Aprikosenernte — süsser als letztes Jahr, sagen die Bauern.\n\nDas Wetter: sonnig, am Nachmittag Quellwolken, 27 Grad. Perfektes Fest-Wetter.",
            "f7": "Two new signings, and we could not be happier: a four-piece surf band from Kiel and a singer-songwriter who records in her grandmother’s barn. First singles drop this month.\n\nSommernacht Open Air is filling up nicely — the lake stage lineup is now complete, gates at 18:00, and yes, the boat shuttle is back by popular demand.\n\nFrom the crate: our sleeve designer picks five covers that made him take up printmaking. Number three is the reason this label has a heron on it.\n\nSee you at the lake.",
            "f8": "Fünf Zelte, vier Wochenenden, ein klarer Favorit: Das leichteste Zelt im Feld gewinnt — nicht wegen des Gewichts, sondern wegen des Aufbaus. Drei Minuten, allein, im Wind.\n\nÜberzeugt hat auch der günstigste Kandidat: solide Nähte, ehrliche 2.1 kg, Schwächen nur bei den Heringen. Das teuerste Modell? Brillant — aber der Aufpreis kauft Farbe, keine Trockenheit.\n\nAlle fünf Testberichte, Messwerte und das Fazit im Vergleich findest du online.\n\nAusserdem im Update: Der Schlafsack-Vergleich startet im September, und das Community-Voting für die Tour des Jahres ist offen — 12'000 Stimmen sind schon drin.",
            "f9": "Welcome back to the Comet Courier! A very good week above the clouds — which in August means warm nights, no moon to speak of, and a meteor shower warming up for its big weekend.\n\nThe headliner: comet Ashida-Lange is running precisely on schedule, brightening on cue, and should be a binocular object by the end of the month. Astronomers are delighted and slightly suspicious — comets are rarely this punctual.\n\nCloser to the ground: the alpine observatory finished its mirror re-coating early, the community telescope night in Winterthur sold out in a day (a second date is coming), and a reader in Ticino photographed the space station crossing the face of the moon on her first try.\n\nNext week: where to stand, when to look, and how to keep your phone from ruining your night vision. Clear skies!",
            "f10": "Hallo Mila\n\nDein Sommerpass ist aktiv! Alle 23 Bergbahnen, den ganzen August — einsteigen, hochfahren, staunen.\n\nUnser Tipp zum Start: die Frühfahrt am Samstag, mit Zopf und Kaffee auf der Terrasse, bevor die Wanderwege aufwachen.\n\nDein Bergbahn Club",
            "f11": "This issue is about color that lives somewhere: a dye garden on a rooftop in Basel, where the indigo does not care about your deadlines.\n\nWe walk through a season of growing color — what the madder root did after two years of patience, why the marigold row earns its keep, and the small chaos of a first indigo vat. The palette that came out of it is now a set of swatches you can actually download.\n\nAlso inside: a palette tool that starts from a photograph of your own shelf, and one brave kitchen painted the green of week-three fennel.\n\nAs always, the printer-friendly version is one click, and the swatch files are free.\n\nComing next issue: the weaving workshop that dyes with onion skins from the restaurant next door.",
            "f12": "August roast: Kenya AA, Nyeri County. Blackcurrant up front, a bright citrus acidity, and a finish that has no business being this long at this price.\n\nWe brew it at 15 g on 250 g water, 94° — and honestly, not after 15:00. It has opinions.\n\nYour bag ships Monday.",
            "f13": "On objects that age well: this issue collects tools that survived a decade of daily use without asking for attention — and asks what they know that the rest of the shelf keeps forgetting.\n\nPlus the usual worthy five, including a chair, a font, and a very good pencil sharpener.",
            "f14": "The week in one read: the paper-mill visit, the interview on margins as kindness, and Friday’s note on why the best bookmarks are borrowed.\n\nIf you read one thing, read Tuesday’s. If you read two, add the interview.",
            "f15": "Der Sommer-Sale endet Sonntag: letzte Balkon-Lieblinge für Garten und Loggia, bis zu 50% reduziert.\n\nSolange der Vorrat reicht — online reservieren, im Showroom abholen.",
        ]
    }

    // MARK: Receipts — 7

    public static func receipts() -> [Message] {
        func m(_ id: String, _ from: String, _ addr: String, _ subj: String, _ amt: String, _ prev: String, _ time: String) -> Message {
            Message(id: id, place: .receipts, from: from, addr: addr, subj: subj, time: time, unread: true, preview: prev, amount: amt)
        }
        return [
            m("brandung", "Brandung Records", "tickets@brandung-records.de", "Your tickets — Sommernacht Open Air 🎫", "CHF 96.00", "2 × Sommernacht Open Air, 22 Aug — see you at the lake stage.", "08:20"),
            m("kino", "Open-Air Kino Seeblick", "tickets@kino-seeblick.ch", "Deine Tickets — Filmnacht am See", "CHF 36.00", "2 × Liegestuhl, Do 21:15 — Decken gibt’s am Eingang.", "07:41"),
            m("erdton", "Atelier Erdton", "billing@erdton-atelier.ch", "Invoice #078 — Pottery Workshop", "CHF 240.00", "Workshop «Glaze & Fire», 2 seats — thanks for booking with us!", "Tue"),
            m("roestsonntag", "Röstsonntag", "hallo@roestsonntag.ch", "Receipt — August roast subscription", "CHF 24.00", "Kenya AA ships Monday — your subscription rolled over.", "Tue"),
            m("speichenhof", "Speichenhof Velos", "service@speichenhof-velos.ch", "Bike service — ready to ride 🚲", "CHF 89.00", "New chain, fresh brakes — she runs like spring again.", "Mon"),
            m("alpenbahn", "Alpenbahn", "tickets@alpenbahn.ch", "Dein Billett Winterthur–Lugano", "CHF 52.00", "Winterthur ab 08:02 — Sitzplatz am Fenster, Seeseite.", "Mon"),
            m("pigment", "Pigment & Papier", "shop@pigmentpapier.de", "Order #5521 shipped 📦", "€31.40", "Gouache set + two brushes — on the way to the studio.", "Mon"),
        ]
    }

    public static func receiptsBodies() -> [String: String] {
        [
            "brandung": "Sommernacht Open Air — Seebühne\nSa 22. August · Doors 18:00\n\n2 × Stehplatz — CHF 96.00\nPaid with the card on file.\n\nYour tickets are attached and in your wallet — the QR codes scan at any gate. Rain or shine; the lake stage has never cancelled.",
            "kino": "Filmnacht am See — Do 31. Juli, 21:15\n\n2 × Liegestuhl-Platz — CHF 36.00\nBezahlt mit der hinterlegten Karte.\n\nBei Regen wandert die Vorstellung auf Freitag — dein Ticket bleibt gültig. Decken und Popcorn gibt es am Eingang.",
            "erdton": "Invoice #078 — July 2026\n\nWorkshop «Glaze & Fire», Sa 9. August, 2 seats — CHF 220.00\nMaterial & firing — CHF 20.00\n\nTotal CHF 240.00 (incl. VAT)\n\nPaid — this is your receipt. Aprons, clay and coffee are on us; bring ideas.",
            "roestsonntag": "August subscription — Kenya AA, 500 g\n\n1 × monthly roast — CHF 24.00\nCharged to the card on file.\n\nYour bag ships Monday with the tasting card. Skip or pause any month with one click.",
            "speichenhof": "Service summary — city bike\n\nNew chain + cassette — CHF 62.00\nBrake pads, front — CHF 18.00\nLabour flat rate — CHF 9.00\n\nTotal CHF 89.00, paid in store.\n\nShe runs like spring again — next check-up is on us.",
            "alpenbahn": "Winterthur → Lugano\nDi 12. August · Abfahrt 08:02 · Ankunft 11:24\n\n1 × 2. Klasse — CHF 52.00\nBezahlt mit der hinterlegten Karte.\n\nSitzplatz 44, Fenster, Seeseite — die schöne Hälfte der Strecke gehört dir.",
            "pigment": "Order #5521 — shipped today\n\nGouache set, 12 colours — €24.90\nBrush, round no. 6 — €3.80\nBrush, flat no. 10 — €2.70\n\nTotal €31.40 (incl. VAT), paid by card.\n\nTracking is in your account — expected Thursday.",
        ]
    }

    public static func receiptGroups() -> [ReceiptGroup] {
        [
            ReceiptGroup(label: "Today", itemIDs: ["brandung", "kino"]),
            ReceiptGroup(label: "Tuesday", itemIDs: ["erdton", "roestsonntag"]),
            ReceiptGroup(label: "Monday", itemIDs: ["speichenhof", "alpenbahn", "pigment"]),
        ]
    }

    // MARK: Screener — 3 waiting / 2 screened / 2 spam

    public static func waiting() -> [WaitingSender] {
        [
            WaitingSender(id: "lena", from: "Lena Kaufmann", addr: "lena@atelier-eichspan.ch", initial: "L", time: "08:40",
                          scope: .sender, ai: AISuggestion(dest: .ohbox, conf: "0.92", why: "personal message, real sender, no bulk fingerprint"),
                          held: HeldMailbag(
                            HeldMail(id: "lena-1", subj: "Werkstatt-Besuch nächste Woche?", time: "08:12",
                                     body: "Hallo Mila\n\nWir haben uns letzten Monat am Handwerksmarkt in Winterthur kurz unterhalten — ich hatte den Stand mit den Eichenmöbeln, gleich neben Ihrer Keramik. Ihre Karte liegt seither auf meiner Werkbank, und jetzt melde ich mich endlich.\n\nHätten Sie nächste Woche Zeit für einen Besuch in der Werkstatt? Ich hätte da eine Idee: Ihre Schalen, meine Tabletts — eine kleine gemeinsame Serie für den Herbstmarkt. Dienstag oder Donnerstag Nachmittag wäre ich frei.\n\nHerzliche Grüsse aus Winterthur\nLena Kaufmann\nAtelier Eichspan"),
                            [
                              HeldMail(id: "lena-2", subj: "Kleine Ergänzung", time: "08:40",
                                       body: "Nochmals kurz: Falls es nächste Woche nicht klappt, ginge auch der Freitag darauf. Und bringen Sie gerne ein paar Schalen mit — ich habe schon ein Tablett im Kopf.\n\nLena"),
                            ])),
            WaitingSender(id: "paperbird", from: "Paperbird", addr: "team@mail.paperbird.app", initial: "P", time: "07:26",
                          scope: .sender, ai: AISuggestion(dest: .reads, conf: "0.88", why: "newsletter fingerprint: List-Unsubscribe, bulk precedence"),
                          held: HeldMailbag(
                            HeldMail(id: "paperbird-1", subj: "Welcome to Paperbird ✏️", time: "07:26",
                                     body: "Hi Mila,\n\nYour notebook is ready. Here are the three things most new members do in their first week:\n\n1. Clip something — articles land clean, without the pop-ups.\n2. Make a collection — drag three clips together and give it a name.\n3. Try the Sunday digest — your clips come back to you once a week, tidy and readable.\n\nA quiet tip: press Cmd+K anywhere. Nearly everything in Paperbird is one box away.\n\nWe send one onboarding mail per week for the next three weeks — you can end the series with one click below.\n\n— The Paperbird team"))),
            WaitingSender(id: "jackpot", from: "JackpotJodel Promo", addr: "win@jackpotjodel-alerts.info", initial: "J", time: "06:58",
                          scope: .domain, dull: true, ai: AISuggestion(dest: .screened, conf: "0.97", why: "promo blast, link-tracker dense, unknown domain"),
                          held: HeldMailbag(
                            HeldMail(id: "jackpot-1", subj: "🎰 Sie haben 3 Freispiele gewonnen!", time: "06:58",
                                     body: "GLÜCKWUNSCH!!! Ihre E-Mail wurde ausgewählt: 3 FREISPIELE + 200% JODEL-BONUS warten auf Sie.\n\n>> JETZT EINLÖSEN — nur 24 Stunden gültig <<\n\nÜber 9'000 Gewinner diese Woche. Verpassen Sie nicht Ihre Chance auf den Jackpot von CHF 1'750'000.\n\nKlicken Sie hier • Bonus aktivieren • Jetzt jodeln\n\nSie erhalten diese Mail, weil Sie sich für Partnerangebote registriert haben. Abmelden.",
                                     trackers: "31 tracking links · 2 spy pixels blocked"))),
        ]
    }

    /// Screened-out senders hold **all** their mail, in full. The list says "8 held"
    /// only because eight rendered messages are behind it.
    public static func screened() -> [ScreenedSender] {
        [
            ScreenedSender(sender: "promo@fashion-deals.ch", date: "12 Jul",
                           held: HeldMailbag(
                            HeldMail(id: "fd-1", subj: "Willkommen — 10% auf die erste Bestellung", time: "2 Mai",
                                     body: "Schön, dass du da bist. Dein Willkommens-Code: HALLO10 — gültig auf alles, 30 Tage.\n\nUnd damit du nichts verpasst: neue Kollektionen landen jeden Donnerstag."),
                            [
                              HeldMail(id: "fd-2", subj: "Neu eingetroffen: Leinen für den Sommer", time: "16 Mai",
                                       body: "Leinen in neun Farben, Hosen mit echten Taschen, und ein Hemd, das auch nach dem Waschen noch aussieht wie am Anfang.\n\nAb CHF 39.90 — solange der Vorrat reicht."),
                              HeldMail(id: "fd-3", subj: "Nur heute: Gratisversand", time: "29 Mai",
                                       body: "Heute versenden wir gratis, ohne Mindestbestellwert. Code: FREITAG.\n\nGilt bis Mitternacht, auch auf reduzierte Artikel."),
                              HeldMail(id: "fd-4", subj: "Du hast etwas im Warenkorb liegen lassen", time: "3 Jun",
                                       body: "Der Korb wartet noch: 1 × Leinenhemd, Grösse M, salbeigrün.\n\nWir halten ihn zwei Tage — danach geben wir die Grösse wieder frei."),
                              HeldMail(id: "fd-5", subj: "Sommer-Sale startet: bis 50%", time: "14 Jun",
                                       body: "Der Sommer-Sale ist offen: über 2'000 Artikel reduziert, Sneaker ab CHF 29.90.\n\nMitglieder haben 24 Stunden Vorsprung — du bist Mitglied."),
                              HeldMail(id: "fd-6", subj: "Deine Grösse ist wieder da", time: "27 Jun",
                                       body: "Das Leinenhemd in Salbeigrün, Grösse M, ist nachgeliefert.\n\nDiesmal in kleiner Stückzahl — wir sagen es dir zuerst."),
                              HeldMail(id: "fd-7", subj: "Letzte Chance: Sale endet Sonntag", time: "5 Jul",
                                       body: "Am Sonntag um 23:59 ist der Sale vorbei. Was dann noch hängt, geht zurück ins Lager.\n\nVersand gratis ab CHF 50."),
                              HeldMail(id: "fd-8", subj: "Mid-Season Sale: bis 70% auf alles", time: "12 Jul",
                                       body: "Nur dieses Wochenende: bis 70% auf über 4'000 Artikel.\n\nSneaker ab CHF 29.90 • Jacken ab CHF 49.90 • Accessoires ab CHF 9.90\n\nGratisversand ab CHF 50 — Code WEEKEND70 an der Kasse."),
                            ])),
            ScreenedSender(sender: "notifications@old-forum.net", date: "3 Jun",
                           held: HeldMailbag(
                            HeldMail(id: "of-1", subj: "1 neue Antwort in „Router-Konfiguration“", time: "21 Mai",
                                     body: "Es gibt 1 neue Antwort in einem Thema, dem du folgst: „Router-Konfiguration VDSL“.\n\n> Bei mir lief es erst, nachdem ich den VLAN-Tag auf 10 gesetzt hatte.\n\nDu erhältst diese Benachrichtigung, weil du das Thema 2019 abonniert hast."),
                            [
                              HeldMail(id: "of-2", subj: "3 neue Antworten in „Router-Konfiguration“", time: "3 Jun",
                                       body: "Es gibt 3 neue Antworten in einem Thema, dem du folgst: „Router-Konfiguration VDSL“.\n\nDu erhältst diese Benachrichtigung, weil du das Thema 2019 abonniert hast. Benachrichtigungen lassen sich im Profil verwalten."),
                            ])),
        ]
    }

    public static func spam() -> [SpamSender] {
        [
            SpamSender(from: "crypto-bonus@win-invest.biz",
                       det: "auto-detected · 0.98 · phishing fingerprint",
                       held: HeldMailbag(
                        HeldMail(id: "wi-1", subj: "Ihr Bitcoin Gewinn wartet 🎁", time: "Tue",
                                 body: "Sehr geehrter Kunde,\n\nIhr Konto zeigt einen nicht abgeholten Gewinn von 0.4 BTC. Bestätigen Sie Ihre Wallet-Adresse innert 48 Stunden, sonst verfällt der Betrag.\n\nJetzt bestätigen → wallet-verify-ch.win-invest.biz\n\nSupport Team",
                                 trackers: "12 tracking links blocked"))),
            SpamSender(from: "support@cinderl0ck-secure.info",
                       det: "auto-detected · 0.96 · lookalike domain (cinderl0ck)",
                       held: HeldMailbag(
                        HeldMail(id: "sk-1", subj: "Ihr Konto wurde eingeschränkt", time: "Mon",
                                 body: "Ihr Cinderlock-Konto wurde vorübergehend eingeschränkt. Um die Einschränkung aufzuheben, bestätigen Sie Ihre Daten über den folgenden Link.\n\nKonto bestätigen → secure.cinderl0ck-secure.info/login\n\nDieser Vorgang dauert nur 2 Minuten.",
                                 trackers: "lookalike link flagged: cinderl0ck-secure.info"))),
        ]
    }

    // MARK: Triage
    //
    // The piles are the single source of truth for triage. Counts, the Reply Run
    // queue and the rail badges are all derived from these arrays — there is
    // no parallel integer to drift out of step.

    public static func piles() -> [TriagePile] {
        [
            TriagePile(kind: .replyLater, title: "Answer Later", items: [
                TriageItem(id: "giulia", title: "Giulia Ferrari",
                           subtitle: "Re: Glaze order #2214 — arriving early 🎉",
                           preview: "Buongiorno Mila, buone notizie — la spedizione arriva già il 4 agosto…"),
                TriageItem(id: "petra", title: "Petra Wyss", subtitle: "Your talk is in! 🎈",
                           preview: "Great news — “Wabi-sabi for web people” made the final program…"),
            ], hint: "Answered one at a time in Reply Run."),
            TriagePile(kind: .setAside, title: "Parked", items: [
                TriageItem(id: "alpenbahn", title: "Alpenbahn",
                           subtitle: "Itinerary Winterthur→Lugano, 12 Aug"),
            ], hint: "Held here until you come back for it."),
            TriagePile(kind: .resurface, title: "Resurface", items: [
                TriageItem(id: "domain-renewal", title: "Domain renewal lichtgrat.studio",
                           subtitle: "", when: "resurfaces Fri 09:00"),
            ], hint: "Returns to the Ohbox at the set time."),
        ]
    }

    // MARK: Settings

    public static func notificationSettings() -> [NotificationSetting] {
        [
            NotificationSetting(title: "People in Ohbox", subtitle: "Mail from people you said Yes to", on: true),
            NotificationSetting(title: "Known senders", subtitle: "Anyone your rules already file", on: true),
            NotificationSetting(title: "Reads", subtitle: "New newsletter issues", on: false),
            NotificationSetting(title: "Receipts", subtitle: "Orders, invoices, tickets", on: false),
            NotificationSetting(title: "Screener holds", subtitle: "Weekly digest instead of alerts", on: false),
        ]
    }

    public static func vips() -> [String] { ["Petra Wyss", "Giulia Ferrari"] }

    public static let learnedSuggestion = "You usually open Petra’s mail within 5 minutes — add to VIP?"
    public static let notificationsPrivacyNote = "Notifications carry no mail content — your device fetches privately."

    // MARK: Search

    /// The Search view opens pre-filled, the way the prototype demonstrates it:
    /// a real typo, so the typo-tolerant pass is the first thing you see working.
    public static let searchInitialQuery = "invoce"

    // MARK: Compose draft

    public static let composeTo = "Giulia Ferrari ‹giulia@terracotta-milano.it›"
    public static let composeSubject = "Re: Glaze order #2214 — arriving early 🎉"
    public static let composeDraft = "Buongiorno Giulia, che bella notizia — il 4 agosto va benissimo! La consegna resta all’atelier, come sempre. Verde salvia e bianco opaco: confermati. A presto, Mila"
    public static let composeGrounding = "Drafted from your 14 previous replies to Giulia + KB: “Delivery replies — standard note”"
}
