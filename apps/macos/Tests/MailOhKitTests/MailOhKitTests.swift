import XCTest
import SwiftUI
@testable import MailOhKit

@MainActor
final class MailOhKitTests: XCTestCase {

    // MARK: Fixture counts (no-collapse rule: every mail is a real fixture)

    func testOhboxCounts() {
        let s = AppState()
        XCTAssertEqual(s.ohbox.count, 9, "Ohbox has all 9 rows rendered — no 'N more' collapse")
        XCTAssertEqual(s.ohbox.filter { $0.unread }.count, 4)
        XCTAssertEqual(s.ohbox.filter { $0.seen }.count, 5)
        XCTAssertEqual(s.ohboxUnread, 4)
        XCTAssertEqual(s.ohboxTotal, 9)
    }

    func testReadsCounts() {
        let s = AppState()
        XCTAssertEqual(s.reads.count, 15)
        XCTAssertEqual(s.reads.filter { $0.unread }.count, 12)
        XCTAssertEqual(s.reads.filter { $0.seen }.count, 3)
        XCTAssertEqual(s.readsNew, 12)
        XCTAssertEqual(s.readsBodies.count, 15, "every Reads item has a real body")
    }

    func testReceiptsCounts() {
        let s = AppState()
        XCTAssertEqual(s.receipts.count, 7)
        XCTAssertEqual(s.receiptsNew, 7)
        let grouped = s.receiptGroups.reduce(0) { $0 + $1.itemIDs.count }
        XCTAssertEqual(grouped, 7, "day groups cover exactly the 7 receipts")
    }

    func testScreenerCounts() {
        let s = AppState()
        XCTAssertEqual(s.waiting.count, 3)
        XCTAssertEqual(s.screened.count, 2)
        XCTAssertEqual(s.spam.count, 2)
        XCTAssertEqual(s.count(for: .waiting), 3)
        XCTAssertEqual(s.count(for: .screened), 2)
        XCTAssertEqual(s.count(for: .spam), 2)
    }

    // MARK: - Invariant #1 — sensitive mail is redacted STRUCTURALLY
    //
    // The point of the enum is that "protected but carrying plaintext" is not a
    // state the program can represent. These tests pin that down at the type level,
    // at the fixture level, and at every consumer that could leak it.

    func testProtectedContentCannotCarryPlaintext() {
        let content = MailContent.sensitiveRedacted(SensitiveMetadata())
        XCTAssertTrue(content.isProtected)
        XCTAssertNil(content.body, "the protected case has no body payload at all")
        XCTAssertNil(content.preview)
        XCTAssertNil(content.searchableText, "nothing to index")
        XCTAssertNil(content.aiPayload, "nothing to send to a model")
        XCTAssertNil(content.forwardableBody, "nothing to forward or quote")
    }

    func testProtectedMessageFactoryHasNoBodyAtAll() {
        let s = AppState()
        let sky = s.ohbox.first { $0.id == "cinderlock" }!
        XCTAssertTrue(sky.isProtected)
        XCTAssertNil(sky.body, "an OTP message carries no plaintext body — stored redacted")
        XCTAssertNil(sky.preview)
        XCTAssertEqual(sky.searchableText, "", "it contributes nothing to the search corpus")
        XCTAssertEqual(sky.sensitive?.klass, .verification)
        XCTAssertNotNil(sky.rationale, "the filing reason is metadata, and it is still shown")
    }

    func testHeldMailAlsoHasAProtectedRepresentation() {
        let h = HeldMail.protected(id: "otp-1", subj: "Your code", time: "08:31")
        XCTAssertTrue(h.isProtected)
        XCTAssertNil(h.body)
        XCTAssertNil(h.content.searchableText)
        // …and a bag of protected mail joins to the policy note, never to content.
        let bag = HeldMailbag(h)
        XCTAssertEqual(bag.joinedBody(redactedNote: Copy.protectedRedactedBody),
                       Copy.protectedRedactedBody)
    }

    func testSearchIndexHoldsNoProtectedContent() {
        let s = AppState()
        let index = s.searchIndex
        let sky = index.entries.first { $0.id == "cinderlock" }
        XCTAssertNotNil(sky, "protected mail is still findable by its metadata")
        // Sender + subject are metadata. Nothing else may be in there.
        XCTAssertEqual(sky?.haystack, "cinderlock your verification code")
        for e in index.entries {
            XCTAssertFalse(e.haystack.contains("verification code ······"),
                           "the redaction label is copy, not index content")
        }
    }

    func testProtectedMailSurvivesAScreenerDecisionWithoutGainingABody() {
        let s = AppState()
        let sender = WaitingSender(
            id: "otp", from: "Cinderlock", addr: "no-reply@cinderlock.app", initial: "S", time: "09:00",
            ai: AISuggestion(dest: .ohbox, conf: "0.99", why: "verification class"),
            held: HeldMailbag(HeldMail.protected(id: "otp-1", subj: "Your code", time: "09:00")))
        s.waiting.append(sender)
        s.decide(sender, to: .ohbox, read: false)
        let filed = s.ohbox.first { $0.id.hasPrefix("scn") }!
        XCTAssertTrue(filed.isProtected)
        XCTAssertNil(filed.body, "filing must not manufacture a body for protected mail")
        XCTAssertEqual(filed.searchableText, "")
    }

    // MARK: - Invariant #6 — no-collapse, including held bags and threads

    func testScreenedSendersCarryEveryHeldMessage() {
        let s = AppState()
        let fashion = s.screened.first { $0.sender == "promo@fashion-deals.ch" }!
        XCTAssertEqual(fashion.heldCount, 8, "'8 held' means eight renderable messages")
        XCTAssertEqual(fashion.held.all.count, 8)
        XCTAssertEqual(Set(fashion.held.all.map(\.id)).count, 8, "each held message has its own identity")
        for h in fashion.held.all {
            XCTAssertFalse((h.body ?? "").isEmpty, "\(h.id) would render an empty card")
            XCTAssertFalse(h.subj.isEmpty)
        }
        let forum = s.screened.first { $0.sender == "notifications@old-forum.net" }!
        XCTAssertEqual(forum.heldCount, 2)
        XCTAssertEqual(forum.held.all.count, 2)
    }

    func testThreadBadgeIsDerivedFromRenderedMessages() {
        let s = AppState()
        let giulia = s.ohbox.first { $0.id == "giulia" }!
        XCTAssertEqual(giulia.thread, 4, "the badge says 4")
        XCTAssertEqual(giulia.earlier.count, 3)
        XCTAssertEqual(giulia.conversation.count, 4, "…and four messages are rendered")
        for h in giulia.conversation {
            XCTAssertFalse((h.body ?? "").isEmpty, "\(h.id) is a thread message with no body")
        }
        // A message with no thread has no badge — the badge cannot be set by hand.
        XCTAssertNil(s.ohbox.first { $0.id == "petra" }?.thread)
    }

    func testHeldMailbagIsNonEmptyByConstruction() {
        XCTAssertNil(HeldMailbag(all: []), "an empty payload fails instead of trapping on [0]")
        let bag = HeldMailbag(all: [HeldMail(id: "a", subj: "A", time: "1", body: "x"),
                                   HeldMail(id: "b", subj: "B", time: "2", body: "y")])
        XCTAssertEqual(bag?.count, 2)
        XCTAssertEqual(bag?.first.id, "a")
        XCTAssertEqual(bag?.newest.id, "b")
        XCTAssertEqual(bag?.all.map(\.id), ["a", "b"])
    }

    func testRenderManifestCoversEveryFixtureIdentity() {
        let s = AppState()
        // Ohbox: 9 rows + the 3 earlier messages of the open thread.
        XCTAssertEqual(Set(s.renderManifest(.ohbox)).count, 12)
        XCTAssertEqual(s.renderManifest(.reads).count, 15)
        XCTAssertEqual(s.renderManifest(.receipts).count, 7)
        // Screener: sender rows + every held message of the selected sender.
        XCTAssertEqual(s.renderManifest(.screener(.waiting)).count, 3 + 2)
        XCTAssertEqual(s.renderManifest(.screener(.screened)).count, 2 + 8)
        XCTAssertEqual(s.renderManifest(.screener(.spam)).count, 2 + 1)
        XCTAssertEqual(s.renderManifest(.triage).count, 4)
        // Compact drops the panes that become their own screens…
        XCTAssertEqual(s.renderManifest(.ohbox, compact: true).count, 9)
        XCTAssertEqual(s.renderManifest(.screener(.screened), compact: true).count, 2)
        // …and those screens promise the rest.
        XCTAssertEqual(s.renderManifest(.ohbox, surface: .reader).count, 4)
        XCTAssertEqual(s.renderManifest(.screener(.screened), surface: .screenerDetail).count, 8)
    }

    func testCopyNeverPromisesUnrenderedMail() {
        // The old copy said "newest of 8 held" and pointed at Search for the rest.
        let lines = [Copy.heldCaption(8), Copy.screenedNote("12 Jul", 8),
                     Copy.ohboxTail(9), Copy.readsTail(15), Copy.receiptsTail(7),
                     Copy.readsStreamTail]
        for line in lines {
            XCTAssertFalse(line.lowercased().contains("newest of"), "collapse language: \(line)")
            XCTAssertFalse(line.lowercased().contains("more"), "collapse language: \(line)")
            XCTAssertFalse(line.lowercased().contains("archived"), "collapse language: \(line)")
        }
        XCTAssertTrue(Copy.heldCaption(8).contains("all shown"))
        XCTAssertTrue(Copy.screenedNote("12 Jul", 8).contains("all shown"))
        XCTAssertTrue(Copy.ohboxTail(9).contains("All 9"))
    }

    // MARK: - Seen semantics — screener "& read" invariant

    func testDecideToOhboxUnreadIncrementsUnread() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .ohbox, read: false)
        XCTAssertEqual(s.ohboxUnread, 5, "filing unread adds one to the unread count")
        XCTAssertEqual(s.ohboxTotal, 10)
    }

    func testDecideToOhboxReadKeepsUnreadInvariant() {
        let s = AppState()
        let before = s.ohboxUnread
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .ohbox, read: true)
        XCTAssertEqual(s.ohboxUnread, before, "'& read' lands as SEEN — the unread count is untouched")
        XCTAssertEqual(s.ohboxTotal, 10, "…but the total grows by one")
        let added = s.ohbox.first { $0.id.hasPrefix("scn") }!
        XCTAssertTrue(added.seen && !added.unread)
    }

    func testDecideToReadsReadKeepsNewInvariant() {
        let s = AppState()
        let before = s.readsNew
        let pb = s.waiting.first { $0.id == "paperbird" }!
        s.decide(pb, to: .reads, read: true)
        XCTAssertEqual(s.readsNew, before, "Reads '& read' does not bump the new count")
        XCTAssertEqual(s.reads.count, 16)
    }

    func testDecideToReadsUnreadBumpsNew() {
        let s = AppState()
        let before = s.readsNew
        let pb = s.waiting.first { $0.id == "paperbird" }!
        s.decide(pb, to: .reads, read: false)
        XCTAssertEqual(s.readsNew, before + 1)
    }

    /// The `& read` half used to be a no-op for Screen out and Spam — those models
    /// had no read state at all, so the toast claimed something that never happened.
    func testAndReadAppliesAtEveryDestination() {
        for dest in Destination.allCases {
            let s = AppState()
            let lena = s.waiting.first { $0.id == "lena" }!
            s.decide(lena, to: dest, read: true)
            switch dest {
            case .ohbox, .reads, .receipts:
                let filed = (s.ohbox + s.reads + s.receipts).first { $0.id.hasPrefix("scn") }!
                XCTAssertTrue(filed.seen, "\(dest) filed as read")
                XCTAssertFalse(filed.unread)
                XCTAssertTrue(filed.earlier.allSatisfy(\.seen),
                              "\(dest): the rest of the thread is read too")
            case .screened:
                let rec = s.screened.first { $0.fromWaitingID == "lena" }!
                XCTAssertTrue(rec.held.all.allSatisfy(\.seen), "screened-out held mail is marked read")
            case .spam:
                let rec = s.spam.first { $0.fromWaitingID == "lena" }!
                XCTAssertTrue(rec.held.all.allSatisfy(\.seen), "spam held mail is marked read")
            }
        }
    }

    func testWithoutAndReadHeldMailStaysUnread() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .screened, read: false)
        let rec = s.screened.first { $0.fromWaitingID == "lena" }!
        XCTAssertTrue(rec.held.all.allSatisfy { !$0.seen })
    }

    // MARK: - Screener decisions are lossless

    func testDecidePreservesEveryHeldMessage() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        XCTAssertEqual(lena.held.count, 2, "Lena arrives with two held messages")
        s.decide(lena, to: .ohbox, read: false)
        let filed = s.ohbox.first { $0.id.hasPrefix("scn") }!
        XCTAssertEqual(filed.conversation.count, 2, "both messages travel — the second is not dropped")
        XCTAssertEqual(filed.earlier.map(\.id), ["lena-1"])
        XCTAssertEqual(filed.subj, "Kleine Ergänzung", "the row shows the newest message")
        XCTAssertEqual(filed.thread, 2)
        XCTAssertTrue(filed.conversation.allSatisfy { !($0.body ?? "").isEmpty })
    }

    func testDecideToReadsKeepsEveryBody() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .reads, read: false)
        let nid = s.reads.first { $0.id.hasPrefix("scn") }!.id
        let joined = s.readsBodies[nid]!
        for h in lena.held.all {
            XCTAssertTrue(joined.contains(h.body!), "\(h.id)'s body is missing from the stream body")
        }
    }

    func testDecideRemovesFromWaitingAndUndoRestores() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        let snap = s.decide(lena, to: .ohbox, read: false)!
        XCTAssertEqual(s.waiting.count, 2)
        s.undo([snap])
        XCTAssertEqual(s.waiting.count, 3)
        XCTAssertEqual(s.ohboxUnread, 4, "undo restores the unread count exactly")
        XCTAssertEqual(s.ohboxTotal, 9)
        XCTAssertNil(s.ohbox.first { $0.id.hasPrefix("scn") })
        XCTAssertEqual(s.waiting.first { $0.id == "lena" }?.held.count, 2,
                       "the restored sender still has both held messages")
    }

    /// Allowing a screened sender used to just delete the record — the eight held
    /// messages went nowhere.
    func testAllowScreenedReleasesEveryHeldMessage() {
        let s = AppState()
        let fashion = s.screened.first { $0.heldCount == 8 }!
        let before = s.ohboxTotal
        let newIDs = s.allowScreened(fashion, to: .ohbox)
        XCTAssertEqual(newIDs.count, 8, "all eight held messages are released")
        XCTAssertEqual(s.ohboxTotal, before + 8)
        XCTAssertTrue(s.screened.allSatisfy { $0.sender != fashion.sender })
        for id in newIDs {
            let m = s.ohbox.first { $0.id == id }!
            XCTAssertFalse((m.body ?? "").isEmpty, "released mail must keep its content")
        }
    }

    func testAllowScreenedIsUndoable() {
        let s = AppState()
        let fashion = s.screened.first { $0.heldCount == 8 }!
        let before = s.ohboxTotal
        s.allowScreened(fashion, to: .ohbox)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.ohboxTotal, before, "the released mail is taken back out")
        XCTAssertEqual(s.screened.count, 2)
        XCTAssertEqual(s.screened.first { $0.sender == fashion.sender }?.heldCount, 8)
    }

    func testAllowScreenedToReadsCarriesBodies() {
        let s = AppState()
        let forum = s.screened.first { $0.heldCount == 2 }!
        let ids = s.allowScreened(forum, to: .reads)
        XCTAssertEqual(ids.count, 2)
        for id in ids { XCTAssertFalse((s.readsBodies[id] ?? "").isEmpty) }
    }

    func testNotSpamMovesEveryHeldMessage() {
        let s = AppState()
        let crypto = s.spam.first!
        let before = s.ohboxTotal
        let ids = s.notSpam(crypto, to: .ohbox)
        XCTAssertEqual(ids.count, crypto.heldCount)
        XCTAssertEqual(s.ohboxTotal, before + crypto.heldCount)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.ohboxTotal, before)
        XCTAssertEqual(s.spam.count, 2, "the spam record comes back")
    }

    func testNotSpamBackToScreenerKeepsTheHeldBag() {
        let s = AppState()
        let crypto = s.spam.first!
        s.notSpam(crypto, to: .screener)
        let back = s.waiting.last!
        XCTAssertEqual(back.held.count, crypto.heldCount)
        XCTAssertEqual(back.held.first.body, crypto.held.first.body)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.waiting.count, 3)
    }

    func testDeleteSpamIsUndoable() {
        let s = AppState()
        let victim = s.spam[1]
        s.deleteSpam(victim)
        XCTAssertEqual(s.spam.count, 1)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.spam.count, 2)
        XCTAssertEqual(s.spam[1].id, victim.id, "it goes back where it was")
    }

    func testAIPreselectDestinations() {
        let s = AppState()
        XCTAssertEqual(s.waiting.first { $0.id == "lena" }?.ai.dest, .ohbox)
        XCTAssertEqual(s.waiting.first { $0.id == "paperbird" }?.ai.dest, .reads)
        XCTAssertEqual(s.waiting.first { $0.id == "jackpot" }?.ai.dest, .screened)
    }

    func testApplyAllClearsWaiting() {
        let s = AppState()
        let snaps = s.applyAllSuggestions()
        XCTAssertEqual(snaps.count, 3)
        XCTAssertTrue(s.waiting.isEmpty)
        // lena→ohbox unread(+1), paperbird→reads(+1), jackpot→screened
        XCTAssertEqual(s.ohboxUnread, 5)
        XCTAssertEqual(s.readsNew, 13)
        XCTAssertEqual(s.screened.count, 3)
    }

    // MARK: - Undo is actually wired to the toast

    func testEveryOfferedUndoIsPending() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .ohbox, read: false)
        XCTAssertEqual(s.toast?.actionLabel, "Undo")
        XCTAssertNotNil(s.pendingUndo, "the toast's Undo has an operation behind it")
    }

    func testUndoPendingRunsOnceAndOnlyOnce() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .ohbox, read: false)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.waiting.count, 3)
        XCTAssertNil(s.pendingUndo, "the operation is consumed")
        XCTAssertFalse(s.undoPending(), "a second tap cannot undo twice")
        XCTAssertEqual(s.waiting.count, 3)
    }

    func testBulkDecisionUndoesAsOneUnit() {
        let s = AppState()
        s.applyAllSuggestions()
        XCTAssertNotNil(s.pendingUndo)
        XCTAssertEqual(s.pendingUndo?.count, 3)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.waiting.count, 3, "all three are waiting again")
        XCTAssertEqual(s.ohboxUnread, 4)
        XCTAssertEqual(s.readsNew, 12)
        XCTAssertEqual(s.screened.count, 2)
    }

    func testMarkAllSpamUndoesAsOneUnit() {
        let s = AppState()
        s.markAllSpam()
        XCTAssertEqual(s.spam.count, 5)
        XCTAssertTrue(s.undoPending())
        XCTAssertEqual(s.spam.count, 2)
        XCTAssertEqual(s.waiting.count, 3)
    }

    func testPlainToastClearsAnyStalePendingUndo() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        s.decide(lena, to: .ohbox, read: false)
        s.showToast("Tagged something.")          // an unrelated, non-undoable action
        XCTAssertNil(s.pendingUndo, "an old operation cannot be undone by a later toast")
    }

    // MARK: - Reads scroll-seen transition

    func testMarkSeenTransitionAndIdempotence() {
        let s = AppState()
        XCTAssertEqual(s.readsNew, 12)
        XCTAssertTrue(s.markSeen("f1"))
        XCTAssertEqual(s.readsNew, 11, "scrolling past one Reads item ticks the count down")
        XCTAssertFalse(s.reads.first { $0.id == "f1" }!.unread)
        XCTAssertFalse(s.markSeen("f1"), "already seen — no second transition")
        XCTAssertEqual(s.readsNew, 11, "count does not double-decrement")
    }

    func testMarkSeenNeverTouchesOhbox() {
        let s = AppState()
        let before = s.ohboxUnread
        XCTAssertFalse(s.markSeen("giulia"), "Ohbox mail is not scroll-seen")
        XCTAssertEqual(s.ohboxUnread, before)
    }

    // MARK: - Stream keyboard: j / k scroll, ↵ expands
    //
    // These are the actions the hint bar advertises. They used to change selection
    // without scrolling, and Return did nothing at all, because expansion and the
    // scroll proxy were private to `StreamView`.

    func testStreamJMovesMarksSeenAndRequestsAScroll() {
        let s = AppState()
        let ids = s.streamItems(for: .reads).map(\.id)
        XCTAssertEqual(s.streamCurrent(.reads), ids[0])
        XCTAssertNil(s.scrollRequest(.reads))

        s.moveStreamSelection(.reads, by: 1)
        XCTAssertEqual(s.streamCurrent(.reads), ids[1])
        XCTAssertEqual(s.scrollRequest(.reads), ids[1], "j scrolls the stream to the selection")
        XCTAssertFalse(s.reads.first { $0.id == ids[1] }!.unread, "moving forward marks seen")

        s.clearScrollRequest(.reads)
        s.moveStreamSelection(.reads, by: -1)
        XCTAssertEqual(s.streamCurrent(.reads), ids[0])
        XCTAssertEqual(s.scrollRequest(.reads), ids[0], "k scrolls too")
    }

    func testStreamSelectionClampsAtBothEnds() {
        let s = AppState()
        let ids = s.streamItems(for: .receipts).map(\.id)
        s.moveStreamSelection(.receipts, by: -5)
        XCTAssertEqual(s.streamCurrent(.receipts), ids.first)
        s.moveStreamSelection(.receipts, by: 99)
        XCTAssertEqual(s.streamCurrent(.receipts), ids.last)
    }

    func testStreamExpansionIsStateTheKeyboardCanReach() {
        let s = AppState()
        XCTAssertFalse(s.isStreamExpanded("f1"))
        XCTAssertTrue(s.toggleStreamExpanded("f1"), "↵ expands")
        XCTAssertTrue(s.isStreamExpanded("f1"))
        XCTAssertFalse(s.toggleStreamExpanded("f1"), "↵ again collapses")
        XCTAssertFalse(s.isStreamExpanded("f1"))
    }

    func testScrollRequestsAreKeptPerPlace() {
        let s = AppState()
        s.requestScroll(.reads, to: "f3")
        s.requestScroll(.receipts, to: "kino")
        XCTAssertEqual(s.scrollRequest(.reads), "f3")
        XCTAssertEqual(s.scrollRequest(.receipts), "kino")
        s.clearScrollRequest(.reads)
        XCTAssertNil(s.scrollRequest(.reads))
        XCTAssertEqual(s.scrollRequest(.receipts), "kino")
    }

    // MARK: - Tags — cross-cutting filtering

    func testTagFiltering() {
        let s = AppState()
        XCTAssertEqual(Set(s.tagged(.pottery).map(\.id)), ["giulia", "flurina"])
        XCTAssertEqual(Set(s.tagged(.buch).map(\.id)), ["erdton", "pigment"])
        XCTAssertEqual(Set(s.tagged(.privat).map(\.id)), ["reto", "tim"])
        XCTAssertEqual(s.tagCount(.pottery), 2)
        XCTAssertEqual(s.tagCount(.buch), 2)
        XCTAssertEqual(s.tagCount(.privat), 2)
    }

    func testToggleTagAcrossViews() {
        let s = AppState()
        XCTAssertTrue(s.toggleTag("brandung", .privat)) // a receipt now carries a tag
        XCTAssertTrue(s.tagged(.privat).contains { $0.id == "brandung" })
        XCTAssertEqual(s.tagCount(.privat), 3)
        XCTAssertFalse(s.toggleTag("brandung", .privat))
        XCTAssertEqual(s.tagCount(.privat), 2)
    }

    // MARK: - Search — typo tolerance, and off the UI actor

    func testSearchFuzzyInvoice() {
        let s = AppState()
        guard case let .results(hits, fuzzy) = s.search("invoce") else {
            return XCTFail("expected fuzzy results for 'invoce'")
        }
        XCTAssertTrue(fuzzy)
        XCTAssertTrue(hits.contains { $0.subject.contains("Invoice") && $0.id == "erdton" },
                      "'invoce' fuzzy-matches the Erdton Invoice #078")
    }

    func testSearchExactAndEmptyAndEgg() {
        let s = AppState()
        if case .results(let hits, let fuzzy) = s.search("giulia") {
            XCTAssertFalse(fuzzy)
            XCTAssertTrue(hits.contains { $0.who == "Giulia Ferrari" })
        } else { XCTFail("expected exact results for 'giulia'") }

        if case .empty = s.search("zzqqxx") {} else { XCTFail("expected empty for gibberish") }
        if case .empty = s.search("") {} else { XCTFail("expected empty for blank query") }
        if case .easterEgg = s.search("blanc") {} else { XCTFail("expected the 'blanc' egg") }
    }

    func testSearchSeesThreadBodies() {
        let s = AppState()
        // "imballato" only exists in Giulia's third (earlier) thread message.
        guard case let .results(hits, _) = s.search("imballato") else {
            return XCTFail("thread bodies must be searchable")
        }
        XCTAssertEqual(hits.map(\.id), ["giulia"])
    }

    func testOffActorSearchAgreesWithTheSynchronousPass() async {
        let s = AppState()
        for q in ["invoce", "giulia", "zzqqxx", "blanc", ""] {
            let sync = s.search(q)
            let async_ = await s.searchOffActor(q)
            XCTAssertEqual(sync, async_, "query “\(q)” disagreed across actors")
        }
    }

    func testSearchIndexIsRebuiltWhenMailChanges() {
        let s = AppState()
        if case .empty = s.search("Paperbird") {} else { XCTFail("Paperbird is not filed yet") }
        let pb = s.waiting.first { $0.id == "paperbird" }!
        s.decide(pb, to: .reads, read: false)
        guard case .results = s.search("Paperbird") else {
            return XCTFail("the index must pick up newly filed mail")
        }
    }

    func testEditDistance() {
        XCTAssertEqual(editDistance("invoce", "invoice"), 1)
        XCTAssertEqual(editDistance("kitten", "sitting"), 3)
        XCTAssertEqual(editDistance("abc", "abc"), 0)
    }

    // MARK: - Privacy audit: the whole corpus, at every depth

    /// Walks every renderable string in the fixtures — including held mail inside
    /// screener records and messages inside threads — against the ban list. The old
    /// version checked three substrings over a shallow corpus, which is why a real
    /// coffee brand sat in Reads and Receipts unnoticed.
    func testPrivacyNoRealIdentitiesOrBrandsAnywhere() {
        let corpus = Self.fixtureCorpus()
        XCTAssertGreaterThan(corpus.count, 150, "the audit must actually cover the fixtures")
        let blob = corpus.joined(separator: "\n").lowercased()
        for term in Fixtures.bannedTerms {
            XCTAssertFalse(blob.contains(term),
                           "privacy invariant: '\(term)' must never appear in fixtures")
        }
    }

    /// The ban list is only as good as its coverage, so the registry is the other
    /// half: every display name the app can render has to be a reviewed entry.
    func testEveryRenderableSenderNameIsInTheFictionalRegistry() {
        let s = AppState()
        let registered = Set(Fixtures.fictionalNames.map(\.name))
        for entry in Fixtures.fictionalNames {
            XCTAssertFalse(entry.note.isEmpty, "\(entry.name) has no review note")
        }
        XCTAssertEqual(registered.count, Fixtures.fictionalNames.count, "duplicate registry entries")
        var names = Set(s.allItems.map(\.from))
        names.formUnion(s.waiting.map(\.from))
        names.formUnion(s.vips)
        for name in names {
            XCTAssertTrue(registered.contains(name),
                          "‘\(name)’ is rendered but not in Fixtures.fictionalNames — add it with a review note")
        }
    }

    /// Mutation check: the audit is only meaningful if it fails on a real hit. The
    /// banned strings are never spelled out here — they are read from the one place
    /// that owns them, so a grep of this app for a real brand finds exactly one
    /// meta-reference (`Fixtures.bannedTerms`) and no planted copies.
    func testTheAuditWouldCatchAnyPlantedBannedTerm() {
        XCTAssertGreaterThan(Fixtures.bannedTerms.count, 15, "the ban list must be broad")
        for term in Fixtures.bannedTerms {
            let planted = Self.fixtureCorpus() + ["Weekly issue from \(term) — number 12"]
            let blob = planted.joined(separator: "\n").lowercased()
            XCTAssertTrue(Fixtures.bannedTerms.contains { blob.contains($0) },
                          "planting a banned term must be caught")
        }
    }

    /// The registry's previous failure mode was a note that merely SOUNDED
    /// reviewed: nine live brands shipped as "coined", because writing the truth
    /// costs exactly as many keystrokes as writing the wrong thing. A verdict of
    /// `.nearCollision` is therefore only accepted with the real twin named.
    func testNearCollisionEntriesNameTheRealEntityTheyCollidedWith() {
        for entry in Fixtures.fictionalNames {
            switch entry.verdict {
            case .nearCollision:
                let named = entry.collision ?? ""
                XCTAssertGreaterThan(named.count, 10,
                                     "‘\(entry.name)’ claims a near-collision but names no twin")
            case .inventedPerson:
                XCTAssertNil(entry.collision, "a person entry should not carry a brand collision")
            case .coined, .descriptive:
                break
            }
        }
        // The verdict has to be load-bearing: if nothing admits a twin, the
        // registry has quietly reverted to "everything is coined".
        XCTAssertTrue(Fixtures.fictionalNames.contains { $0.verdict == .nearCollision },
                      "no entry admits a near-collision — review has gone silent again")
    }

    /// The ban list must not be silently self-contradicting: the product still
    /// ships one banned term as its IMAP folder namespace, and that exemption is
    /// written down rather than left for the next reader to rediscover.
    func testTheNamespaceExemptionPointsAtATermThatIsActuallyBanned() {
        XCTAssertTrue(Fixtures.bannedTerms.contains(Fixtures.namespaceExemption.term))
        XCTAssertFalse(Fixtures.namespaceExemption.until.isEmpty)
    }

    static func fixtureCorpus() -> [String] {
        let s = AppState()
        var out: [String] = []
        for m in s.allItems {
            out += [m.from, m.addr, m.subj, m.rationale ?? "", m.tracker ?? "", m.attach ?? ""]
            for h in m.conversation { out += [h.subj, h.body ?? "", h.trackers ?? ""] }
        }
        out += s.readsBodies.values
        out += s.receiptsBodies.values
        for w in s.waiting {
            out += [w.from, w.addr, w.ai.why]
            for h in w.held.all { out += [h.subj, h.body ?? "", h.trackers ?? ""] }
        }
        for x in s.screened {
            out.append(x.sender)
            for h in x.held.all { out += [h.subj, h.body ?? "", h.trackers ?? ""] }
        }
        for x in s.spam {
            out += [x.from, x.det]
            for h in x.held.all { out += [h.subj, h.body ?? "", h.trackers ?? ""] }
        }
        out += s.mailboxes.flatMap { [$0.address, $0.kind, $0.shortName] }
        out += s.railMailboxes.map(\.shortName)
        out += s.piles.flatMap { p in p.items.flatMap { [$0.title, $0.subtitle, $0.preview ?? ""] } }
        out += [s.ownerAddress, s.composeTo, s.composeSubject, s.composeDraft, s.composeGrounding,
                s.learnedSuggestion, s.notificationsPrivacyNote, s.streamArtCaption]
        out += s.vips
        // The registry's review notes are source content a reviewer reads, so they
        // are audited too — a note that names a real brand is still a real brand in
        // this repository.
        out += Fixtures.fictionalNames.map(\.note)
        out += Fixtures.fictionalNames.compactMap(\.collision)
        return out.filter { !$0.isEmpty }
    }

    // MARK: - Triage: one source of truth

    func testTriageCountsAreDerivedFromThePiles() {
        let s = AppState()
        XCTAssertEqual(s.replyCount, 2)
        XCTAssertEqual(s.asideCount, 1)
        XCTAssertEqual(s.resurfaceCount, 1)
        XCTAssertEqual(s.triageMeta, "4 items")
        for kind in PileKind.allCases {
            XCTAssertEqual(s.pileCount(kind), s.pile(kind)?.items.count,
                           "\(kind) count must be the pile itself, not a parallel integer")
        }
    }

    func testQueueingIsIdempotentAndCountsFollowTheItems() {
        let s = AppState()
        let ben = s.ohbox.first { $0.id == "ben" }!
        s.replyLater(ben)
        XCTAssertEqual(s.replyCount, 3)
        XCTAssertEqual(s.pile(.replyLater)?.items.count, 3)
        s.replyLater(ben)
        XCTAssertEqual(s.replyCount, 3, "queueing the same mail twice is a no-op")
        XCTAssertTrue(s.toast!.message.contains("already queued"))

        s.setAside(ben)
        XCTAssertEqual(s.asideCount, 2)
        s.setAside(ben)
        XCTAssertEqual(s.asideCount, 2)

        s.resurface(ben)
        XCTAssertEqual(s.resurfaceCount, 2)
        XCTAssertEqual(s.pile(.resurface)?.items.last?.when, "resurfaces Fri 09:00")
    }

    func testAlreadyQueuedFixtureMailIsRecognised() {
        let s = AppState()
        let giulia = s.ohbox.first { $0.id == "giulia" }!
        s.replyLater(giulia)
        XCTAssertEqual(s.replyCount, 2, "Giulia is already in the Answer Later pile")
    }

    /// "Done → next" discarded the typed draft and left the item in the pile, so
    /// reopening a Reply Run re-presented work that had been done.
    func testFocusReplySavesTheDraftAndRemovesTheItem() {
        let s = AppState()
        s.startFocusReply()
        XCTAssertEqual(s.focusReplyQueue.count, 2)
        let first = s.focusReplyQueue[0]

        XCTAssertTrue(s.saveFocusReplyDraft("Va benissimo — a presto!"))
        XCTAssertEqual(s.drafts[first.id], "Va benissimo — a presto!", "the draft is saved, not dropped")
        XCTAssertEqual(s.focusReplyQueue.count, 1, "the answered item leaves the pile")
        XCTAssertEqual(s.replyCount, 1, "and the count follows")
        XCTAssertTrue(s.toast!.message.contains("not sent"),
                      "nothing is sent in this build, and the copy says so")

        // Reopening starts at the top of a shorter queue — never re-presenting.
        s.startFocusReply()
        XCTAssertEqual(s.focusReplyIndex, 0)
        XCTAssertFalse(s.focusReplyQueue.contains { $0.id == first.id })
    }

    func testFocusReplySkipLeavesTheItemQueued() {
        let s = AppState()
        s.startFocusReply()
        s.focusReplySkip()
        XCTAssertEqual(s.focusReplyIndex, 1)
        XCTAssertEqual(s.focusReplyQueue.count, 2, "skipping does not complete anything")
        XCTAssertEqual(s.replyCount, 2)
    }

    func testFocusReplyEmptyDraftStillClearsTheItemWithoutInventingADraft() {
        let s = AppState()
        s.startFocusReply()
        let first = s.focusReplyQueue[0]
        XCTAssertTrue(s.saveFocusReplyDraft("   "))
        XCTAssertNil(s.drafts[first.id], "no draft is fabricated from whitespace")
        XCTAssertEqual(s.replyCount, 1)
    }

    func testFocusReplyRefusesToRunPastTheEndOfTheQueue() {
        let s = AppState()
        s.startFocusReply()
        XCTAssertTrue(s.saveFocusReplyDraft("a"))
        XCTAssertTrue(s.saveFocusReplyDraft("b"))
        XCTAssertEqual(s.replyCount, 0)
        XCTAssertFalse(s.saveFocusReplyDraft("c"), "nothing left to save")
    }

    func testResurfacePileHasScheduledTime() {
        let s = AppState()
        let resurface = s.pile(.resurface)!
        XCTAssertTrue(resurface.items.contains { $0.when == "resurfaces Fri 09:00" })
    }

    func testReadsWaterlineMetaPresent() {
        XCTAssertEqual(AppState().readsWaterlineMeta, "last visit · Mon 18:40")
    }

    // MARK: - Theme tokens: fidelity against packages/tokens, not against memory

    /// Every color token is compared numerically to `packages/tokens/src/tokens.ts`.
    /// The previous theme test checked broad relationships plus one accent value,
    /// which is why a hand-written shadow could drift without failing anything.
    func testColorTokensMatchTokensTS() throws {
        let source = try String(contentsOf: Self.repoRoot.appendingPathComponent("packages/tokens/src/tokens.ts"),
                               encoding: .utf8)
        for (schemeName, palette) in [("light", Palette.light), ("dark", Palette.dark)] {
            let block = try Self.block(named: schemeName, in: source)
            for (token, value) in Self.tokenMap(palette) {
                guard let authored = Self.oklch(token, in: block) else {
                    return XCTFail("\(schemeName).\(token) is not in tokens.ts")
                }
                assertSameOKLCH(value, authored, "\(schemeName).\(token)")
            }
            for (name, hue) in [("moss", palette.moss), ("ochre", palette.ochre), ("rosewood", palette.rosewood)] {
                let line = try Self.line(containing: "\(name): {", in: block)
                let pair = Self.allOKLCH(in: line)
                XCTAssertEqual(pair.count, 2, "\(schemeName).tag.\(name)")
                assertSameOKLCH(hue.ink, pair[0], "\(schemeName).tag.\(name).ink")
                assertSameOKLCH(hue.bg, pair[1], "\(schemeName).tag.\(name).bg")
            }
        }
    }

    func testRadiusAndLayoutTokensMatchTokensTS() throws {
        let source = try String(contentsOf: Self.repoRoot.appendingPathComponent("packages/tokens/src/tokens.ts"),
                               encoding: .utf8)
        let radius = try Self.constBlock("radius", in: source)
        let spacing = try Self.constBlock("spacing", in: source)
        let layout = try Self.constBlock("layout", in: source)

        let radii: [(String, CGFloat)] = [
            ("dot", Radius.dot), ("keycap", Radius.keycap), ("focus", Radius.focus),
            ("item", Radius.item), ("menuItem", Radius.menuItem), ("paletteItem", Radius.paletteItem),
            ("rowDense", Radius.rowDense), ("row", Radius.row), ("input", Radius.input),
            ("panel", Radius.panel), ("card", Radius.card), ("overlay", Radius.overlay),
            ("reader", Radius.reader),
        ]
        for (name, value) in radii {
            XCTAssertEqual(value, try Self.px("\(name):", in: radius), accuracy: 0.001, "radius.\(name)")
        }
        for (name, value) in [("deck", Space.deck), ("paneX", Space.paneX),
                              ("messageX", Space.messageX), ("dockClearance", Space.dockClearance)] {
            XCTAssertEqual(value, try Self.px("\(name):", in: spacing), accuracy: 0.001, "spacing.\(name)")
        }
        for (name, value) in [("mobileMax", Space.mobileMax), ("rail", Space.rail),
                              ("streamMax", Space.streamMax), ("messageMax", Space.messageMax),
                              ("readerMax", Space.readerMax)] {
            XCTAssertEqual(value, try Self.px("\(name):", in: layout), accuracy: 0.001, "layout.\(name)")
        }
        // `split: "minmax(320px,400px) 1fr"` — the one list-column width.
        let split = try Self.line(containing: "split:", in: layout)
        let bounds = Self.numbers(in: split)
        XCTAssertEqual(Space.listColMin, bounds[0], accuracy: 0.001, "layout.split min")
        XCTAssertEqual(Space.listColMax, bounds[1], accuracy: 0.001, "layout.split max")
    }

    /// The one token that had drifted: the triage pile's stacked-sheet edge, authored
    /// at alpha .10 in the prototype and duplicated by hand at .16.
    ///
    /// The Blanc prototype is *not* part of the public `mailoh` mirror (it is
    /// an unreleased design source, and `scripts/publish-desktop.mjs` refuses to copy
    /// it), so in a public checkout this check has nothing to compare against and
    /// skips loudly rather than pretending to pass. In the monorepo the file is always
    /// there and the assertion runs — this is the check that caught the .10 → .16 drift.
    func testPileSheetEdgeMatchesTheCanonicalPrototype() throws {
        let prototype = Self.repoRoot.appendingPathComponent("design/proposals/blanc/index.html")
        guard FileManager.default.fileExists(atPath: prototype.path) else {
            throw XCTSkip("""
                design/proposals/blanc/index.html is monorepo-only — this fidelity check \
                runs in the private monorepo, not in the public mirror.
                """)
        }
        let html = try String(contentsOf: prototype, encoding: .utf8)
        let rule = try Self.line(containing: ".pile-stack::before,.pile-stack::after", in: html)
            + (try Self.line(containing: "border-radius:14px 14px 0 0", in: html))
        guard let authored = Self.allOKLCH(in: rule).first else {
            return XCTFail("could not find the sheet-edge shadow in the prototype")
        }
        let layers = Lift.sheetEdge.layers(.light)
        XCTAssertEqual(layers.count, 1)
        assertSameOKLCH(layers[0].color, authored, "sheetEdge")
        XCTAssertEqual(layers[0].y, -2, "the sheet edge casts upward")
        XCTAssertEqual(layers[0].radius, 4, accuracy: 0.001, "8px CSS blur → radius 4")
    }

    func testThemeRelationshipsStillHold() {
        let light = Palette.of(.light), dark = Palette.of(.dark)
        XCTAssertGreaterThan(light.canvas.srgb.r, 0.95)
        XCTAssertLessThan(dark.canvas.srgb.r, 0.15)
        XCTAssertLessThan(dark.canvas.l, dark.panel.l)
        XCTAssertLessThan(dark.panel.l, dark.float.l)
        XCTAssertLessThan(light.ink.srgb.r, 0.3)
        XCTAssertGreaterThan(dark.ink.srgb.r, 0.8)
    }

    func testOKLCHConversionKnownValues() {
        XCTAssertEqual(OKLCH(1, 0, 0).hex, "#ffffff")
        XCTAssertEqual(OKLCH(0, 0, 0).hex, "#000000")
        // the burnt-sienna accent resolves to its documented sRGB hex
        XCTAssertEqual(OKLCH(0.51, 0.135, 42).hex, "#a3461c")
        XCTAssertEqual(Palette.light.accent.hex, "#a3461c")
    }

    // MARK: - Source audits: no untracked visual constants, no fixtures in views

    func testNoUntrackedVisualConstants() throws {
        for (name, source) in try Self.viewSources() {
            XCTAssertFalse(source.contains("OKLCH("),
                           "\(name) hand-writes a color — every color comes from Palette")
            XCTAssertFalse(source.contains(".shadow("),
                           "\(name) hand-writes a shadow — every shadow comes from the Lift scale")
        }
    }

    func testViewsNeverReachForFixtures() throws {
        for (name, source) in try Self.viewSources() {
            XCTAssertFalse(source.contains("Fixtures."),
                           "\(name) reads fixtures directly — fixture knowledge stops at AppState")
        }
    }

    /// The two rows that were `HStack` + `onTapGesture`, so VoiceOver had no
    /// activation action for them.
    func testPaletteAndTagRowsAreRealButtons() throws {
        let source = try Self.source("Views/Overlays.swift")
        XCTAssertFalse(source.contains(".onTapGesture { onClose(); s.runCommand"),
                       "palette rows must be Buttons")
        XCTAssertFalse(source.contains(".onTapGesture { s.toggleTag"),
                       "tag rows must be Buttons")
        XCTAssertTrue(source.contains("Button { onClose(); s.runCommand"))
        XCTAssertTrue(source.contains("Button { s.toggleTag"))
        XCTAssertTrue(source.contains(".accessibilityAddTraits(.isModal)"),
                      "overlay layers mark themselves modal")
    }

    // MARK: - Body measurement (replaces the duplicate hidden body tree)

    func testBodyMetricsGrowWithContentAndAreStable() {
        let short = "One line."
        let long = String(repeating: "A reasonably long paragraph of newsletter copy. ", count: 40)
        let hShort = BodyMetrics.streamBodyHeight(short, cardWidth: 620)
        let hLong = BodyMetrics.streamBodyHeight(long, cardWidth: 620)
        XCTAssertGreaterThan(hShort, 0)
        XCTAssertGreaterThan(hLong, hShort * 4, "more text must measure taller")
        XCTAssertEqual(BodyMetrics.streamBodyHeight(long, cardWidth: 620), hLong,
                       "the measurement is cached, so it must be stable")
        XCTAssertGreaterThan(BodyMetrics.streamBodyHeight(long, cardWidth: 300), hLong,
                            "a narrower card wraps to more lines")
    }

    func testBodyMetricsAccountForTheInlineFigure() {
        let plain = "Kleine Räume, grosse Wirkung."
        let withFigure = "Kleine Räume, grosse Wirkung.\n\(MailContent.imageMarker)\nDer Klapptisch KLAPPRI."
        XCTAssertGreaterThan(BodyMetrics.streamBodyHeight(withFigure, cardWidth: 620),
                             BodyMetrics.streamBodyHeight(plain, cardWidth: 620) + 100,
                             "the figure occupies real height in the clamp decision")
    }

    // MARK: - Layout floor (invariant #7)

    func testShellSupports390Points() {
        XCTAssertLessThanOrEqual(Space.minWidth, 390, "the shell must be clean at 390pt")
        XCTAssertEqual(Space.mobileMax, 900, "the compact breakpoint is the canonical one")
        // Below the breakpoint one pane has to go: rail + list minimum alone is wider
        // than 390pt, which is exactly why the compact layout exists.
        XCTAssertGreaterThan(Space.rail + Space.listColMin, Space.minWidth)
    }

    // MARK: - Screener selection & scope

    func testScreenerSelectionFallsBackAndMoves() {
        let s = AppState()
        XCTAssertEqual(s.screenerSelection(.waiting), "lena")
        s.moveScreenerSelection(.waiting, by: 1)
        XCTAssertEqual(s.screenerSelection(.waiting), "paperbird")
        s.moveScreenerSelection(.waiting, by: 5)
        XCTAssertEqual(s.screenerSelection(.waiting), "jackpot", "j clamps at the end")
        s.moveScreenerSelection(.waiting, by: -9)
        XCTAssertEqual(s.screenerSelection(.waiting), "lena", "k clamps at the start")

        // a stale selection resolves to the first row rather than blanking the pane
        s.setScreenerSelection(.waiting, "gone")
        XCTAssertEqual(s.screenerSelection(.waiting), "lena")
    }

    func testHeldMailAccessorReturnsTheWholeBag() {
        let s = AppState()
        XCTAssertEqual(s.heldMail(.waiting).map(\.id), ["lena-1", "lena-2"])
        s.setScreenerSelection(.screened, "promo@fashion-deals.ch")
        XCTAssertEqual(s.heldMail(.screened).count, 8)
        XCTAssertEqual(s.heldMail(.spam).count, 1)
    }

    func testDecisionScopeChangesTheStatedRule() {
        let s = AppState()
        let lena = s.waiting.first { $0.id == "lena" }!
        XCTAssertEqual(s.ruleTarget(lena), "lena@atelier-eichspan.ch")
        s.setScope("lena", .domain)
        XCTAssertEqual(s.ruleTarget(s.waiting.first { $0.id == "lena" }!), "@atelier-eichspan.ch")
        // the jackpot promo is domain-scoped out of the box
        XCTAssertEqual(s.ruleTarget(s.waiting.first { $0.id == "jackpot" }!),
                       "@jackpotjodel-alerts.info")
    }

    func testDecideToReceiptsJoinsTheFirstDayGroup() {
        let s = AppState()
        let before = s.receiptRows[0].items.count
        let pb = s.waiting.first { $0.id == "paperbird" }!
        s.decide(pb, to: .receipts, read: false)
        XCTAssertEqual(s.receiptRows[0].items.count, before + 1)
        XCTAssertEqual(s.receiptRows.reduce(0) { $0 + $1.items.count }, 8,
                       "still no orphaned receipt — every one is in a rendered group")
    }

    // MARK: - Render lists

    func testRenderListsCoverEveryOhboxMessage() {
        let s = AppState()
        XCTAssertEqual(s.ohboxNew.count + s.ohboxSeen.count, 9,
                       "the two Ohbox groups render all 9 rows between them")
        XCTAssertEqual(Set(s.ohboxNew.map(\.id)).intersection(s.ohboxSeen.map(\.id)), [],
                       "no message is rendered twice")
        XCTAssertEqual(s.ohboxMeta, "4 unread of 9")
    }

    func testRenderListsCoverEveryReadsItem() {
        let s = AppState()
        XCTAssertEqual(s.readsUnseen.count, 12)
        XCTAssertEqual(s.readsSeen.count, 3)
        XCTAssertEqual(s.streamItems(for: .reads).count, 15, "the skim stream renders all 15")
        XCTAssertEqual(s.readsMeta, "12 new")
    }

    func testRenderListsCoverEveryReceipt() {
        let s = AppState()
        XCTAssertEqual(s.receiptRows.reduce(0) { $0 + $1.items.count }, 7,
                       "the day groups render all 7 receipts")
        XCTAssertEqual(s.receiptRows.map(\.label), ["Today", "Tuesday", "Monday"])
        XCTAssertEqual(s.streamItems(for: .receipts).count, 7)
    }

    func testEveryRenderedItemHasABody() {
        let s = AppState()
        for m in s.streamItems(for: .reads) + s.streamItems(for: .receipts) {
            XCTAssertFalse(s.body(for: m).isEmpty, "\(m.id) renders an empty card")
        }
    }

    // MARK: - Ohbox keyboard selection

    func testOhboxSelectionWalksTheRenderedOrder() {
        let s = AppState()
        XCTAssertEqual(s.selectedOhboxID, "giulia")
        s.moveOhboxSelection(by: 1)
        XCTAssertEqual(s.selectedOhboxID, "petra")
        s.moveOhboxSelection(by: -1)
        XCTAssertEqual(s.selectedOhboxID, "giulia")
        s.moveOhboxSelection(by: -1)
        XCTAssertEqual(s.selectedOhboxID, "giulia", "k stops at the top of the list")
        s.moveOhboxSelection(by: 99)
        XCTAssertEqual(s.selectedOhboxID, s.ohboxSeen.last?.id,
                       "j walks into the Previously-seen group and stops at the end")
    }

    // MARK: - Theme resolution

    func testThemePreferenceResolution() {
        let s = AppState()
        XCTAssertEqual(s.effectiveScheme(system: .dark), .dark, "system follows the system")
        XCTAssertEqual(s.effectiveScheme(system: .light), .light)
        s.themePref = .dark
        XCTAssertEqual(s.effectiveScheme(system: .light), .dark, "an explicit choice wins")
        s.themePref = .light
        XCTAssertEqual(s.effectiveScheme(system: .dark), .light)
    }

    // MARK: - Command palette

    func testPaletteFuzzyFilterAndRouting() {
        let s = AppState()
        XCTAssertEqual(s.filteredCommands("").count, s.paletteCommands.count)
        XCTAssertTrue(s.filteredCommands("gtr").contains { $0.label == "Go to Reads" },
                      "subsequence matching finds 'Go to Reads' from 'gtr'")
        XCTAssertTrue(s.filteredCommands("spam").contains { $0.label == "Screener: Spam" })
        XCTAssertTrue(s.filteredCommands("zzqq").isEmpty)

        let cmd = s.paletteCommands.first { $0.label == "Open Screener" }!
        s.runCommand(cmd)
        XCTAssertEqual(s.route, .screener(.waiting))
    }

    func testPaletteToggleThemeAndTagCommands() {
        let s = AppState()
        s.themePref = .light
        s.runCommand(s.paletteCommands.first { $0.label == "Toggle light / dark" }!)
        XCTAssertEqual(s.themePref, .dark)

        s.selectedOhboxID = "ben"
        s.runCommand(s.paletteCommands.first { $0.label == "Tag: Paperwork…" }!)
        XCTAssertTrue(s.tags("ben").contains(.buch), "the tag command acts on the selection")
    }

    func testPaletteResurfaceActsOnTheSelection() {
        let s = AppState()
        s.selectedOhboxID = "ben"
        s.runCommand(s.paletteCommands.first { $0.label == "Resurface selection" }!)
        XCTAssertTrue(s.pile(.resurface)!.items.contains { $0.id == "ben" })
    }

    // MARK: - Search facets are derived, never fabricated

    func testSearchFacetsComeFromTheHits() {
        let s = AppState()
        guard case let .results(hits, _) = s.search("giulia") else {
            return XCTFail("expected results")
        }
        let f = s.facets(for: hits)
        XCTAssertEqual(f.senders.reduce(0) { $0 + $1.count }, hits.count,
                       "facet counts sum to the real hit count")
        for place in f.places {
            XCTAssertTrue(["Ohbox", "Reads", "Receipts"].contains(place))
        }
    }

    // MARK: - The smoke walk covers the router, both widths and every overlay

    func testSmokeCoversEveryRouteAndOverlay() {
        XCTAssertEqual(Smoke.routes, Route.allCases,
                       "the walk reads the router, so it cannot drift")
        XCTAssertEqual(Smoke.routes.count, 13)
        // The About panel and the tag picker used to be omitted from "every overlay".
        let overlays = Set(Smoke.Overlay.allCases.map(\.rawValue))
        for expected in ["reading", "palette", "focusReply", "toast", "about", "tagPicker"] {
            XCTAssertTrue(overlays.contains(expected), "--smoke never renders the \(expected) overlay")
        }
        XCTAssertEqual(Smoke.Viewport.all.map(\.name), ["desktop", "390"],
                       "both verified widths are walked")
    }

    func testSmokeAppliesEveryOverlayToTheState() {
        for overlay in Smoke.Overlay.allCases where overlay != .none {
            let s = AppState()
            Smoke.apply(overlay, to: s)
            let touched = s.isReading || s.isPaletteOpen || s.isFocusReplyOpen
                || s.isAboutOpen || s.tagPickerFor != nil || s.toast != nil
            XCTAssertTrue(touched, "\(overlay) did not actually put anything on screen")
        }
    }

    // MARK: - The verification bites (mutation checks on the harness itself)

    func testBlankDetectorRejectsAUniformBitmap() {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 200, pixelsHigh: 200,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB,
                                  bytesPerRow: 0, bitsPerPixel: 0)!
        // Paint it a single flat color — exactly the "laid out fine, drew nothing" case.
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSBezierPath(rect: CGRect(x: 0, y: 0, width: 200, height: 200)).fill()
        NSGraphicsContext.restoreGraphicsState()

        let stats = Smoke.PixelStats(rep)
        XCTAssertNotNil(stats)
        XCTAssertLessThan(stats!.distinctColors, Smoke.minDistinctColors,
                          "a flat bitmap must fail the blank check")
        XCTAssertLessThan(stats!.inkFraction, Smoke.minInkFraction,
                          "a flat bitmap has no ink")
    }

    func testBlankDetectorAcceptsARealRender() {
        let state = AppState()
        state.route = .ohbox
        let renderer = ImageRenderer(
            content: RootView(state).environment(\.staticRender, true)
                .frame(width: 1440, height: 1700, alignment: .top)
        )
        renderer.scale = 1
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let stats = Smoke.PixelStats(rep) else {
            return XCTFail("the Ohbox must rasterise")
        }
        XCTAssertGreaterThanOrEqual(stats.distinctColors, Smoke.minDistinctColors)
        XCTAssertGreaterThanOrEqual(stats.inkFraction, Smoke.minInkFraction)
    }

    /// The no-collapse audit is only worth having if a collapsed list fails it. This
    /// renders a view that *does* collapse and proves the check catches it.
    func testRowAuditCatchesACollapsedList() {
        let ids = (1...12).map { "m\($0)" }
        let collapsed = Self.render(CollapsingList(ids: ids, limit: 3))
        let missing = RenderLog.missing(expected: ids, rendered: collapsed)
        XCTAssertEqual(missing.count, 9, "nine rows were replaced by a '9 more' placeholder")
        XCTAssertEqual(missing.first, "m4")

        let complete = Self.render(CollapsingList(ids: ids, limit: 12))
        XCTAssertTrue(RenderLog.missing(expected: ids, rendered: complete).isEmpty,
                      "…and a complete list passes")
    }

    func testSmokeRowAuditPassesForEveryRealSurface() {
        for viewport in Smoke.Viewport.all {
            for route in Smoke.routes {
                let failures = Smoke.auditRows(route: route, surface: .deck, viewport: viewport)
                XCTAssertTrue(failures.isEmpty,
                              "\(route.slug) @\(viewport.name): \(failures.map(\.why).joined(separator: "; "))")
            }
            for seg in ScreenerSeg.allCases {
                let failures = Smoke.auditRows(route: .screener(seg), surface: .screenerDetail,
                                               viewport: viewport)
                XCTAssertTrue(failures.isEmpty, "screener \(seg) detail @\(viewport.name)")
            }
            let reader = Smoke.auditRows(route: .ohbox, surface: .reader, viewport: viewport)
            XCTAssertTrue(reader.isEmpty, "reader @\(viewport.name): \(reader.map(\.why))")
        }
    }

    /// Every held message of a screened sender really is built by a view — the
    /// specific regression that "8 held / 1 rendered" was.
    func testScreenedDetailRendersAllEightHeldMessages() {
        let s = AppState()
        s.route = .screener(.screened)
        s.setScreenerSelection(.screened, "promo@fashion-deals.ch")
        let rendered = Smoke.renderedIDs(state: s, route: .screener(.screened), viewport: .desktop)
        for id in (1...8).map({ "fd-\($0)" }) {
            XCTAssertTrue(rendered.contains(id), "held message \(id) was never rendered")
        }
    }

    // MARK: - Microcopy stays factual (no slogans in-app)

    func testProtectedPolicyCopyStatesTheInvariant() {
        let policy = Copy.protectedLead + Copy.protectedPolicy
        XCTAssertTrue(policy.contains("never sent to AI"))
        XCTAssertTrue(policy.contains("never forwarded"))
        XCTAssertTrue(policy.contains("stored redacted"))
        XCTAssertEqual(Copy.protectedPreview, "Verification code ······ (redacted)")
    }

    func testDecisionBarStatesTheConsequence() {
        let note = Copy.decideRule("lena@atelier-eichspan.ch")
        XCTAssertTrue(note.contains("Becomes a rule"))
        XCTAssertTrue(note.contains("lena@atelier-eichspan.ch"))
        XCTAssertTrue(note.contains("marks this mail read"),
                      "the ✓ half's effect is stated, not implied")
    }

    func testFocusReplyCopyDoesNotClaimToSend() {
        XCTAssertTrue(Copy.focusReplySave.lowercased().contains("draft"))
        XCTAssertFalse(Copy.focusReplySave.lowercased().contains("send"))
        XCTAssertTrue(Copy.focusReplySendNote.contains("Sending arrives with the engine slice"))
    }

    // MARK: - Helpers

    /// Renders a view through `ImageRenderer` with a `RenderLog` attached and returns
    /// what the tree actually built.
    static func render<V: View>(_ view: V) -> [String] {
        let log = RenderLog()
        let renderer = ImageRenderer(
            content: view.environment(\.renderLog, log)
                .environment(\.staticRender, true)
                .frame(width: 600, height: 1200, alignment: .top)
        )
        renderer.scale = 1
        _ = renderer.nsImage
        return log.recorded
    }

    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // MailOhKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
            .deletingLastPathComponent()   // apps
            .deletingLastPathComponent()   // repo root
    }

    static func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent("apps/macos/Sources/MailOhKit/\(relative)"),
                   encoding: .utf8)
    }

    /// Every file under `Views/`, for the source audits.
    static func viewSources() throws -> [(String, String)] {
        let dir = repoRoot.appendingPathComponent("apps/macos/Sources/MailOhKit/Views")
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThan(names.count, 10, "the audit found almost no view files")
        return try names.map { ($0, try String(contentsOf: dir.appendingPathComponent($0), encoding: .utf8)) }
    }

    func assertSameOKLCH(_ swift: OKLCH, _ authored: OKLCH, _ label: String) {
        XCTAssertEqual(swift.l, authored.l, accuracy: 0.0005, "\(label) L")
        XCTAssertEqual(swift.c, authored.c, accuracy: 0.0005, "\(label) C")
        XCTAssertEqual(swift.h, authored.h, accuracy: 0.05, "\(label) H")
        XCTAssertEqual(swift.alpha, authored.alpha, accuracy: 0.0005, "\(label) alpha")
    }

    static func tokenMap(_ p: Palette) -> [(String, OKLCH)] {
        [("canvas", p.canvas), ("panel", p.panel), ("float", p.float),
         ("ink", p.ink), ("ink2", p.ink2), ("ink3", p.ink3),
         ("hair", p.hair), ("hairSoft", p.hairSoft),
         ("tint", p.tint), ("tint2", p.tint2),
         ("accent", p.accent), ("accentInk", p.accentInk), ("accentSoft", p.accentSoft),
         ("accentHair", p.accentHair), ("onAccent", p.onAccent), ("scrim", p.scrim)]
    }

    /// The `light: { … }` / `dark: { … }` block of `color` in tokens.ts.
    static func block(named name: String, in source: String) throws -> String {
        let colorStart = try require(source.range(of: "export const color"), "color block")
        let start = try require(source.range(of: "\(name): {", range: colorStart.upperBound..<source.endIndex),
                                "\(name) block")
        let end = try require(source.range(of: "\n  },", range: start.upperBound..<source.endIndex),
                              "\(name) block end")
        return String(source[start.upperBound..<end.lowerBound])
    }

    static func line(containing needle: String, in source: String) throws -> String {
        for line in source.split(separator: "\n", omittingEmptySubsequences: false)
        where line.contains(needle) { return String(line) }
        throw Failure("no line containing “\(needle)”")
    }

    static func oklch(_ token: String, in block: String) -> OKLCH? {
        guard let line = try? line(containing: "\(token):", in: block) else { return nil }
        return allOKLCH(in: line).first
    }

    /// Parses every `oklch(L C H)` / `oklch(L C H / .A)` in a string.
    static func allOKLCH(in text: String) -> [OKLCH] {
        let pattern = #"oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:/\s*([0-9.]+))?\s*\)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            func d(_ i: Int) -> Double? {
                let r = m.range(at: i)
                guard r.location != NSNotFound else { return nil }
                return Double(ns.substring(with: r))
            }
            return OKLCH(d(1) ?? 0, d(2) ?? 0, d(3) ?? 0, d(4) ?? 1)
        }
    }

    /// The body of `export const <name> = { … } as const;`.
    static func constBlock(_ name: String, in source: String) throws -> String {
        let start = try require(source.range(of: "export const \(name)"), "const \(name)")
        let open = try require(source.range(of: "{", range: start.upperBound..<source.endIndex),
                               "\(name) opening brace")
        let end = try require(source.range(of: "} as const;", range: open.upperBound..<source.endIndex),
                              "\(name) closing brace")
        return String(source[open.upperBound..<end.lowerBound])
    }

    static func numbers(in text: String) -> [CGFloat] {
        var out: [CGFloat] = []
        var current = ""
        for ch in text {
            if ch.isNumber || (ch == "." && !current.isEmpty) { current.append(ch) }
            else if !current.isEmpty { if let v = Double(current) { out.append(CGFloat(v)) }; current = "" }
        }
        if let v = Double(current) { out.append(CGFloat(v)) }
        return out
    }

    static func px(_ key: String, in source: String) throws -> CGFloat {
        let line = try line(containing: key, in: source)
        guard let value = numbers(in: line).first else { throw Failure("no px value on “\(line)”") }
        return value
    }

    static func require<T>(_ value: T?, _ what: String) throws -> T {
        guard let value else { throw Failure("could not find \(what)") }
        return value
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}

/// A list that deliberately collapses, used to prove the no-collapse audit bites.
private struct CollapsingList: View {
    let ids: [String]
    let limit: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(ids.prefix(limit), id: \.self) { id in
                Text(id).recordRender(id)
            }
            if ids.count > limit {
                Text("\(ids.count - limit) more")
            }
        }
    }
}
