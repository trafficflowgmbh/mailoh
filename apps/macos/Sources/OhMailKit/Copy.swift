import Foundation

/// Every string the chrome says, in one place. Blanc's rule is **factual
/// microcopy only** — no slogans, no praise, no invented numbers. Each line here
/// is either verbatim from the canonical prototype
/// (`design/proposals/blanc/index.html`) or a literal statement of what the app
/// just did. Keeping them together makes that auditable.
public enum Copy {

    // MARK: Ohbox

    public static let groupNew = "New"
    public static let groupSeen = "Earlier"
    /// Tail rows state that the list is complete — the no-collapse rule in words.
    /// They never imply a hidden count on this screen.
    public static func ohboxTail(_ shown: Int) -> String {
        "All \(shown) accepted message\(shown == 1 ? "" : "s") shown. Search reaches the rest of your server."
    }
    public static let doorbellGo = "Screener ›"
    public static func doorbell(_ n: Int) -> String { "\(n) new sender\(n == 1 ? "" : "s")" }
    public static let doorbellRest = "waiting"

    // MARK: Reads · Receipts

    public static let waterline = "Seen up to here"
    public static func readsTail(_ shown: Int) -> String {
        "All \(shown) issue\(shown == 1 ? "" : "s") shown. Scrolling past an item marks it seen."
    }
    public static let readsStreamTail = "End of the stream — every issue above is a full issue."
    public static func receiptsTail(_ shown: Int) -> String {
        "All \(shown) receipt\(shown == 1 ? "" : "s") shown. Search reaches older ones on your server."
    }
    public static let streamSeenHint = "scrolling past marks seen"

    /// The classifier chip, stated from **one message's own classification**.
    ///
    /// A function rather than a constant, and that is the whole of it: this line
    /// used to be `readsChipPending = "Reads — AI 0.87: newsletter fingerprint"`,
    /// a shared constant rendered over whatever the newest issue happened to be.
    /// A confidence and a reason are facts the mailbox owns about one message, so
    /// against a real source that constant stated an invented number about
    /// somebody's actual mail. The number and the reason now come from
    /// `Classification`; the vocabulary around them is all that is left here.
    public static func readsChip(_ c: Classification) -> String {
        switch c.decision {
        case .pending: return "\(c.dest.label) — AI \(c.confidenceText): \(c.reason)"
        case .approved: return readsChipApproved
        case .corrected: return "Corrected — goes to \(c.correction.label) next time"
        }
    }
    public static let readsChipApproved = "Approved — saved as a rule"
    /// The same two statements as sentences, for the toast that follows the answer.
    public static let readsChipApprovedToast = readsChipApproved + "."
    public static func readsChipCorrectedToast(_ dest: Destination) -> String {
        "Corrected — this sender goes to \(dest.label) next time."
    }

    // MARK: Protected (sensitive-mail invariant, stated as fact)

    public static let protectedPreview = "Verification code ······ (redacted)"
    public static let protectedCodeLabel = "Verification code"
    public static let protectedRedacted = "(redacted)"
    /// Stands in for a protected body wherever mail text would otherwise be joined
    /// (stream body stores, thread rendering). There is no plaintext to join.
    public static let protectedRedactedBody = "(protected — no content was stored)"
    public static let protectedLead = "Protected"
    public static let protectedPolicy =
        " — never sent to AI, never forwarded, stored redacted. Codes live and die on your device."

    // MARK: Screener

    public static let applyAll = "Apply all suggestions"
    public static let markAllSpam = "Mark all spam"
    public static let scopeSender = "this sender"
    public static let scopeDomain = "whole domain"
    public static let decideReadNote = "The ✓ half also marks this mail read."
    public static func decideRule(_ target: String) -> String {
        "Becomes a rule — future mail from \(target) files automatically. \(decideReadNote)"
    }
    public static let decideKeys = "accept · ⇧+key marks read"
    public static let allowLabel = "Allow…"
    public static let allowChoose = "allow — release held mail to"
    public static func screenedNote(_ date: String, _ held: Int) -> String {
        "Screened \(date) · \(held) held, all shown. Allowing releases every one of them to the chosen view."
    }
    /// Caption above a held-mail list. States completeness, never a remainder.
    public static func heldCaption(_ n: Int, firstContact: String? = nil) -> String {
        let head = "\(n) held message\(n == 1 ? "" : "s") — all shown"
        guard let firstContact else { return head }
        return head + " · first contact \(firstContact)"
    }
    public static let notSpamLabel = "Not spam…"
    public static let notSpamChoose = "not spam — move all held mail to"
    public static let spamNote =
        "Detection reads structure — sender, headers, link targets. Content is not sent anywhere."

    public struct EmptyCopy: Sendable {
        public let glyph: String, title: String, sub: String
    }
    public static func screenerEmpty(_ seg: ScreenerSeg) -> EmptyCopy {
        switch seg {
        case .waiting: return EmptyCopy(glyph: "🕊", title: "No one’s waiting.",
            sub: "First-time senders appear here before anything reaches the Ohbox.")
        case .screened: return EmptyCopy(glyph: "🚪", title: "No senders screened out.",
            sub: "Screening out a waiting sender lists them here — reversible any time.")
        case .spam: return EmptyCopy(glyph: "🕳", title: "No spam held.",
            sub: "Auto-detected spam lands here for review — nothing is deleted unseen.")
        }
    }

    // MARK: Triage

    public static let focusReply = "Reply Run"
    public static let focusReplyNote = "Steps through the Answer Later pile, one message per screen."
    public static let focusReplyEmpty = "Answer Later is empty."
    /// Explicit save semantics: this build has no mailbox, so nothing can be sent
    /// and the button never claims otherwise.
    public static let focusReplySave = "Save draft → next"
    public static let focusReplySendNote = "Saved on this device. Sending arrives with the engine slice."

    // MARK: Tags

    public static let tagEmpty = "Nothing carries this tag yet."
    public static let tagEmptySub = "Press t on a message to add it."
    public static let tagsNote =
        "A tag groups messages across Ohbox, Reads and Receipts without moving them."

    // MARK: Search

    public static let searchPlaceholder = "Search everything — typos welcome"
    public static let searchIndex = "local index"
    public static let searchEmptyTitle = "No local results."
    public static let searchEmptySub = "Press ↵ to search the server archive."
    public static let searchEggTitle = "Blanc."
    public static let searchEggSub = "Direction 03c — the design direction this prototype is built in."
    public static func fuzzyNote(_ term: String) -> String { "fuzzy match — “\(term)”" }

    // MARK: Compose

    public static let draftTag = "AI draft — not sent"
    public static let sendNote = "Draft — not sent"
    public static let composePlaceholder = "Write your message, or take the draft above."

    // MARK: Settings

    public static let mailboxesNote = "Mail stays in real folders on these servers."
    public static let themeNote = "Follows the system unless set"
    public static let vipHeading = "VIP — always notifies"
    public static let connected = "Connected"

    // MARK: Message actions

    public static let actions = ["Reply", "Answer Later", "Park", "Resurface"]
    public static let move = "Move"
    public static let draftReply = "Draft reply"

    // MARK: Dock

    public static let command = "Command"
    public static let paletteHint = "Type a command…"
    public static let paletteEmpty = "No command — try “screener”, “tag”, “theme”…"

    // MARK: Compact layout (≤900pt — the drawer + single-pane detail)

    public static let menu = "Menu"
    public static let back = "Back"
    public static let openReader = "Open"
}
