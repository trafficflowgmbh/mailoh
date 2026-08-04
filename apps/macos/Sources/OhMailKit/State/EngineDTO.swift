import Foundation

// THE WIRE, AND ONLY THE WIRE.
//
// Everything in this file is a mirror of what the local engine actually sends — the same REST
// shapes the web client's adapter reads, arriving here over a pipe instead of a socket. Nothing
// here is a model: no view sees one of these, and `MailWorld` is built from them by
// `EngineProjection` rather than being one of them.
//
// ── `Codable` LIVES HERE AND IS BANNED ONE FILE UP, AND THAT IS DELIBERATE ────────────────────
//
// `MailSource.swift` says "Nothing here is `Codable`, deliberately", and `Models/SourceState.swift`
// gives the reason: making the seam types codable would quietly promote them to a wire format and
// pin whatever engine sits behind the seam to serialising exactly that shape. That rule is about
// the SEAM. These types sit BELOW it — they are the engine's shape, not the app's — so being
// decodable is the whole of their job.
//
// So: do not "fix" either side. Adding `Codable` to `Message` or `MailWorld` would delete the
// boundary; removing it from here would mean hand-rolling `JSONSerialization` casts for every
// field, which is the same decode with the type checker switched off.
//
// ── EVERY FIELD IS OPTIONAL-WITH-A-DEFAULT, AND THAT IS NOT LAZINESS ─────────────────────────
//
// The API contract's forward-compatibility rule is that a client must tolerate fields it does not
// know and fields that stop arriving. A `Decodable` synthesised from non-optional properties does
// the opposite: one absent field throws, and a throw here loses the WHOLE `/sync` page — every
// message on it, not just the one that changed shape. So each type below decodes what it finds and
// falls back to a stated default, and only an entity with no `id` is refused.
//
// `folder` is a RAW STRING for the same reason, and it is the sharpest instance of it. A closed
// Swift enum with a throwing initialiser would let one folder name this build has never heard of
// poison an entire page of somebody's mail. `EngineProjection` maps the string through a table and
// leaves what it cannot place out of the six views.

// MARK: - Small pieces

struct WireAddress: Decodable, Equatable {
    var name: String?
    var address: String = ""

    init(name: String? = nil, address: String = "") {
        self.name = name; self.address = address
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? nil
        address = try c.decodeIfPresent(String.self, forKey: .address) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case name, address }

    /// What a row calls this person: their name if the sender wrote one, otherwise the address.
    /// Never a fabricated pleasantry — an address is a true thing to call somebody.
    var display: String { (name?.isEmpty == false ? name : nil) ?? address }
}

/// The pipeline's verdict about a message's content class. `sensitive` is the one this app acts
/// on: it is what makes the projection build a `Message` that structurally cannot hold plaintext.
struct WireSensitivity: Decodable, Equatable {
    var sensitive: Bool = false
    var category: String?
    var noAI: Bool = false
    var noForward: Bool = false
    var noKB: Bool = false
    var priority: Bool = false

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sensitive = try c.decodeIfPresent(Bool.self, forKey: .sensitive) ?? false
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? nil
        noAI = try c.decodeIfPresent(Bool.self, forKey: .noAI) ?? false
        noForward = try c.decodeIfPresent(Bool.self, forKey: .noForward) ?? false
        noKB = try c.decodeIfPresent(Bool.self, forKey: .noKB) ?? false
        priority = try c.decodeIfPresent(Bool.self, forKey: .priority) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case sensitive, category, priority
        case noAI = "no_ai"
        case noForward = "no_forward"
        case noKB = "no_kb"
    }
}

/// Where a message sits in the reader's own triage, if anywhere.
struct WireTriage: Decodable, Equatable {
    var state: String = "none"
    var bubbleUpAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "none"
        bubbleUpAt = try c.decodeIfPresent(String.self, forKey: .bubbleUpAt) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case state, bubbleUpAt }
}

// MARK: - The message

struct WireMessage: Decodable, Equatable {
    var id: String
    var threadId: String?
    var subject: String = ""
    var from = WireAddress()
    var to: [WireAddress] = []
    /// When the sender sent it. **Nullable on the wire and nullable here**: a message whose
    /// headers carried no `Date` really has none, and inventing one would put a row in the wrong
    /// place in somebody's list rather than at the end of it, where "we do not know" belongs.
    var date: String?
    /// The raw IMAP folder. A string, never an enum — see the file header.
    var folder: String = ""
    var snippet: String = ""
    var unread: Bool = false
    var hasAttachments: Bool = false
    var attachmentCount: Int = 0
    var sensitivity = WireSensitivity()
    var triage: WireTriage?
    var labels: [String] = []
    var updatedAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = try c.decodeIfPresent(String.self, forKey: .id), !id.isEmpty else {
            throw EngineWireError("a message arrived with no id, so nothing could refer to it")
        }
        self.id = id
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId) ?? nil
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        from = try c.decodeIfPresent(WireAddress.self, forKey: .from) ?? WireAddress()
        to = try c.decodeIfPresent([WireAddress].self, forKey: .to) ?? []
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? nil
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? ""
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        hasAttachments = try c.decodeIfPresent(Bool.self, forKey: .hasAttachments) ?? false
        attachmentCount = try c.decodeIfPresent(Int.self, forKey: .attachmentCount) ?? 0
        sensitivity = try c.decodeIfPresent(WireSensitivity.self, forKey: .sensitivity) ?? WireSensitivity()
        triage = try c.decodeIfPresent(WireTriage.self, forKey: .triage) ?? nil
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, threadId, subject, from, to, date, folder, snippet, unread
        case hasAttachments, attachmentCount, sensitivity, triage, labels, updatedAt
    }
}

// MARK: - /sync

/// One delta. `entity` is decoded ONLY for the types this build projects; everything else is a
/// change it records the existence of and ignores the payload of, which is what lets the engine
/// grow an entity type without this client losing a page of mail over it.
struct WireChange: Decodable {
    var type: String = ""
    var op: String = ""
    var id: String = ""
    /// The account's global order of record. Deltas are applied in this order and never in bucket
    /// order — see `EngineProjection.mirror(from:)`.
    var seq: Int = 0
    var message: WireMessage?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
        op = try c.decodeIfPresent(String.self, forKey: .op) ?? ""
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
        message = type == "message" ? try c.decodeIfPresent(WireMessage.self, forKey: .entity) : nil
    }

    private enum CodingKeys: String, CodingKey { case type, op, id, seq, entity }
}

struct WireSyncResponse: Decodable {
    var creates: [WireChange] = []
    var updates: [WireChange] = []
    var moves: [WireChange] = []
    var deletes: [WireChange] = []
    var cursor: String = "0"
    var hasMore: Bool = false

    /// Every delta on this page, in the account's own order rather than in bucket order.
    ///
    /// The buckets are four lists of the same feed, and one message id appears in several of them
    /// on a first drain — created, moved into `ohmail/Screener`, then updated by a read receipt.
    /// Applying them bucket by bucket would let the create win over the update whenever the
    /// buckets happen to be ordered that way, which is a message that silently goes back to
    /// unread. `seq` is the order of record; this is it.
    var ordered: [WireChange] {
        (creates + updates + moves + deletes).sorted { $0.seq < $1.seq }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let changes = try? c.nestedContainer(keyedBy: BucketKeys.self, forKey: .changes) {
            creates = try changes.decodeIfPresent([WireChange].self, forKey: .creates) ?? []
            updates = try changes.decodeIfPresent([WireChange].self, forKey: .updates) ?? []
            moves = try changes.decodeIfPresent([WireChange].self, forKey: .moves) ?? []
            deletes = try changes.decodeIfPresent([WireChange].self, forKey: .deletes) ?? []
        }
        cursor = try c.decodeIfPresent(String.self, forKey: .cursor) ?? "0"
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }

    private enum CodingKeys: String, CodingKey { case changes, cursor, hasMore }
    private enum BucketKeys: String, CodingKey { case creates, updates, moves, deletes }
}

// MARK: - The other routes

/// `GET /messages/:id/body`.
///
/// `text` arrives ALREADY redacted for a protected message — the engine does that, and this client
/// stores what it was given and never attempts a redaction of its own. A second implementation of
/// that rule is a second place for it to be wrong.
struct WireBody: Decodable {
    var text: String = ""
    var html: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        html = try c.decodeIfPresent(String.self, forKey: .html) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case text, html }
}

/// `PATCH /messages { ids, unread }` — one DTO back per id, **whether or not anything changed**.
/// The count is therefore not an answer to "how many moved"; see `EngineSource.markSeen`.
struct WireMarkSeenResult: Decodable {
    var items: [WireMessage] = []

    /// An answer with nothing in it. Used when the engine's 2xx body cannot be read at all — the
    /// write may well have landed, so this is not a refusal, but nothing can be claimed to have
    /// moved on the strength of bytes nobody could parse.
    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([WireMessage].self, forKey: .items) ?? []
    }

    private enum CodingKeys: String, CodingKey { case items }
}

/// `GET /mailboxes`. Identity, read once at start — never per cycle.
struct WireMailbox: Decodable {
    var address: String = ""
    var displayName: String?
    var provider: String = ""
    var status: String = ""

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        address = try c.decodeIfPresent(String.self, forKey: .address) ?? ""
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? nil
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case address, displayName, provider, status }
}

struct WireMailboxList: Decodable {
    var items: [WireMailbox] = []

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([WireMailbox].self, forKey: .items) ?? []
    }

    private enum CodingKeys: String, CodingKey { case items }
}

/// The engine's refusal envelope — `{error: {code, message, retryable}}`, the same one the hosted
/// API speaks.
///
/// It is read rather than flattened to the status code because the message is the sentence the
/// reader is shown. A source that could only say "failed" forces every surface to invent copy, and
/// invented copy is how an app tells somebody their mailbox is empty when the truth is that the
/// password expired.
struct WireErrorEnvelope: Decodable {
    var code: String?
    var message: String?
    var retryable: Bool?

    init(from decoder: Decoder) throws {
        let outer = try decoder.container(keyedBy: OuterKeys.self)
        let c = try? outer.nestedContainer(keyedBy: CodingKeys.self, forKey: .error)
        code = try c?.decodeIfPresent(String.self, forKey: .code) ?? nil
        message = try c?.decodeIfPresent(String.self, forKey: .message) ?? nil
        retryable = try c?.decodeIfPresent(Bool.self, forKey: .retryable) ?? nil
    }

    private enum OuterKeys: String, CodingKey { case error }
    private enum CodingKeys: String, CodingKey { case code, message, retryable }
}

/// A wire payload this build cannot make sense of at all.
struct EngineWireError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
