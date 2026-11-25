#include "models.h"

#include <QFile>
#include <QtTest>

static QByteArray fixture(const char *name)
{
    QFile f(QStringLiteral(SCHMEAR_FIXTURES "/%1.json").arg(name));
    if (!f.open(QIODevice::ReadOnly))
        qFatal("cannot open fixture %s", name);
    return f.readAll();
}

class TestModels : public QObject {
    Q_OBJECT
private slots:
    void decodesSnapshot()
    {
        QString error;
        const auto s = decodeSnapshot(fixture("snapshot"), &error);
        QVERIFY2(s, qPrintable(error));
        QCOMPARE(s->at, 1700000000000.0);
        QVERIFY(s->hosts.isEmpty());
        QCOMPARE(s->readings.size(), 2);
        QCOMPARE(s->readings[0].warnings, QStringList{"usage endpoint is undocumented"});
        QCOMPARE(s->readings[0].pools[0].pace, std::optional<double>(1.42));
        QCOMPARE(s->readings[0].pools[0].windows[1].resetsAt, std::optional<double>(1700184800000));
        QCOMPARE(s->readings[0].pools[1].pace, std::nullopt);
        QCOMPARE(s->readings[0].pools[1].models, QStringList{"opus"});
        QCOMPARE(s->readings[0].pools[1].windows[0].resetsAt, std::nullopt);
        QCOMPARE(s->readings[0].pools[0].windows[0].projectedUnused, std::optional<double>(0.12));
        QCOMPARE(s->readings[0].pools[0].windows[1].projectedUnused, std::optional<double>(0));
        QCOMPARE(s->readings[0].pools[1].windows[0].projectedUnused, std::nullopt);
        QCOMPARE(s->readings[1].skipped, std::optional<QString>("not configured"));
        QCOMPARE(s->next[1].lane, std::nullopt);
        QCOMPARE(s->notOffered.size(), 1);
        QStringList statuses;
        for (const auto &t : s->tasks)
            statuses << t.status;
        QCOMPARE(statuses, (QStringList{"running", "done", "lost"}));
        QCOMPARE(s->tasks[1].costUsd, std::optional<double>(0.0123));
        QCOMPARE(s->tasks[1].endedAt, std::optional<double>(1699999280000));
    }

    void decodesCreditUsd()
    {
        QString error;
        const auto s = decodeSnapshot(fixture("snapshot-credits"), &error);
        QVERIFY2(s, qPrintable(error));
        QVERIFY(!s->readings[0].pools[0].usd);
        QCOMPARE(s->readings[1].pools[0].usd->left, 4.2);
        QCOMPARE(s->readings[1].pools[0].usd->granted, 5.0);
        QCOMPARE(s->readings[1].pools[0].usd->expiring, std::optional<double>(3));
        QCOMPARE(s->readings[2].pools[0].usd->expiring, std::nullopt);
        QVERIFY(!decodeSnapshot(QByteArray(fixture("snapshot-credits")).replace(R"("granted": 5)", R"("granted": "5")"), &error));
        QCOMPARE(error, QStringLiteral("schmear returned output this app cannot read: field \"granted\""));
    }

    void decodesWithoutCreditDetails()
    {
        QString error;
        const auto s = decodeSnapshot(fixture("snapshot"), &error);
        QVERIFY2(s, qPrintable(error));
        QVERIFY(s->notices.isEmpty());
        for (const auto &r : s->readings) {
            QCOMPARE(r.login, std::nullopt);
            for (const auto &p : r.pools)
                QCOMPARE(p.name, std::nullopt);
        }
    }

    void decodesCreditDetailsAndNotices()
    {
        const QByteArray json = R"({"version":1,"at":1700000000000,"readings":[
            {"id":"claude-credits@soon","login":"claude@default","warnings":[],"pools":[
                {"id":"claude-credits@soon","name":"Org 1","windows":[],
                 "usd":{"left":60,"granted":110,"expiring":50,"grant":50,"purchased":10,"spentMonth":3},"status":"ok"}]}],
            "next":[],"notOffered":[],"tasks":[],
            "notices":[{"id":"expiring:claude-credits@soon:1700172800000","title":"$50 of API credit expires Nov 16",
                        "body":"claude-credits@soon (Org 1) expires in 2 days. Delegate work to spend it."}]})";
        QString error;
        const auto s = decodeSnapshot(json, &error);
        QVERIFY2(s, qPrintable(error));
        const auto &r = s->readings[0];
        QCOMPARE(r.login, std::optional<QString>("claude@default"));
        QCOMPARE(r.pools[0].name, std::optional<QString>("Org 1"));
        QCOMPARE(r.pools[0].usd->left, 60.0);
        QCOMPARE(r.pools[0].usd->expiring, std::optional<double>(50));
        QCOMPARE(r.pools[0].usd->grant, std::optional<double>(50));
        QCOMPARE(r.pools[0].usd->purchased, std::optional<double>(10));
        QCOMPARE(r.pools[0].usd->spentMonth, std::optional<double>(3));
        QCOMPARE(s->notices.size(), 1);
        QCOMPARE(s->notices[0].id, QStringLiteral("expiring:claude-credits@soon:1700172800000"));
        QCOMPARE(s->notices[0].title, QStringLiteral("$50 of API credit expires Nov 16"));
        QCOMPARE(s->notices[0].body, QStringLiteral("claude-credits@soon (Org 1) expires in 2 days. Delegate work to spend it."));
        QVERIFY(!decodeSnapshot(QByteArray(json).replace(R"("title":"$50 of API credit expires Nov 16")", R"("title":60)"), &error));
        QCOMPARE(error, QStringLiteral("schmear returned output this app cannot read: field \"title\""));
    }

    void decodesHosts()
    {
        QString error;
        const auto s = decodeSnapshot(fixture("snapshot-hosts"), &error);
        QVERIFY2(s, qPrintable(error));
        QCOMPARE(s->hosts.size(), 3);
        QCOMPARE(s->hosts[0].id, QStringLiteral("claude"));
        QCOMPARE(s->hosts[0].status, QStringLiteral("ok"));
        QCOMPARE(s->hosts[1].id, QStringLiteral("codex"));
        QCOMPARE(s->hosts[1].status, QStringLiteral("stale"));
        QCOMPARE(s->hosts[2].id, QStringLiteral("agy"));
        QCOMPARE(s->hosts[2].status, QStringLiteral("missing"));
    }

    void decodesTiers()
    {
        QString error;
        const auto t = decodeTiers(fixture("tiers"), &error);
        QVERIFY2(t, qPrintable(error));
        QCOMPARE(t->source, QStringLiteral("config"));
        QCOMPARE(t->maxTasks, 12);
        QCOMPARE(t->tiers[1], (QStringList{"claude:sonnet@high", "codex:gpt-5@medium"}));
        QCOMPARE(t->laneKeys.size(), 3);
        QCOMPARE(t->offered.value("codex"), QStringList{"gpt-5"});
        QVERIFY(!t->offered.contains("agy-gemini"));
    }

    void rejectsBadMaxTasks()
    {
        QString error;
        QVERIFY(!decodeTiers(R"({"version":1,"source":"config","tiers":[],"laneKeys":[],"offered":{}})", &error));
        QCOMPARE(error, QStringLiteral("schmear returned output this app cannot read: field \"maxTasks\""));
        error.clear();
        QVERIFY(!decodeTiers(R"({"version":1,"source":"config","maxTasks":1.5,"tiers":[],"laneKeys":[],"offered":{}})", &error));
        QCOMPARE(error, QStringLiteral("schmear returned output this app cannot read: field \"maxTasks\""));
    }

    void rejectsOtherVersions()
    {
        const QByteArray data = R"({"version": 2})";
        const QString expected = QStringLiteral(
            "schmear returned data version 2, which this app does not understand. Update the app or schmear.");
        QString error;
        QVERIFY(!decodeSnapshot(data, &error));
        QCOMPARE(error, expected);
        error.clear();
        QVERIFY(!decodeTiers(data, &error));
        QCOMPARE(error, expected);
    }

    void rejectsNonJson()
    {
        QString error;
        QVERIFY(!decodeSnapshot("not json", &error));
        QVERIFY2(error.startsWith("schmear returned output this app cannot read:"), qPrintable(error));
    }

    void namesMissingField()
    {
        QString error;
        QVERIFY(!decodeSnapshot(R"({"version":1})", &error));
        QCOMPARE(error, QStringLiteral("schmear returned output this app cannot read: field \"at\""));
    }

    void encodesTiers()
    {
        QString error;
        const auto doc = decodeTiers(fixture("tiers"), &error);
        QVERIFY2(doc, qPrintable(error));
        QList<QList<TierEntry>> tiers;
        for (const QStringList &tier : doc->tiers) {
            QList<TierEntry> entries;
            for (const QString &spec : tier)
                entries << TierEntry::fromSpec(spec);
            tiers << entries;
        }
        QCOMPARE(tiersJson(tiers), QByteArray(R"([["claude:haiku@medium"],["claude:sonnet@high","codex:gpt-5@medium"]])"));
    }

    void parsesPlainSpec()
    {
        const auto e = TierEntry::fromSpec("claude:sonnet@high");
        QCOMPARE(e.key, QStringLiteral("claude"));
        QCOMPARE(e.model, QStringLiteral("sonnet"));
        QCOMPARE(e.effort, QStringLiteral("high"));
        QVERIFY(e.isComplete());
    }

    void modelMayContainAtAndColon()
    {
        const auto e = TierEntry::fromSpec("agy:models/gemini@2:preview@medium");
        QCOMPARE(e.key, QStringLiteral("agy"));
        QCOMPARE(e.model, QStringLiteral("models/gemini@2:preview"));
        QCOMPARE(e.effort, QStringLiteral("medium"));
    }

    void missingEffort()
    {
        const auto e = TierEntry::fromSpec("claude:sonnet");
        QCOMPARE(e.key, QStringLiteral("claude"));
        QCOMPARE(e.model, QStringLiteral("sonnet"));
        QCOMPARE(e.effort, QString());
        QVERIFY(!e.isComplete());
    }

    void missingColon()
    {
        const auto e = TierEntry::fromSpec("claude");
        QCOMPARE(e.key, QStringLiteral("claude"));
        QCOMPARE(e.model, QString());
        QCOMPARE(e.effort, QString());
        QVERIFY(!e.isComplete());
    }

    void specRoundTrips()
    {
        QCOMPARE(TierEntry::fromSpec("codex:gpt-5@medium").spec(), QStringLiteral("codex:gpt-5@medium"));
        QCOMPARE(TierEntry("codex").spec(), QStringLiteral("codex:@"));
    }

    void blankPartsAreIncomplete()
    {
        QVERIFY(!TierEntry::fromSpec("claude: @high").isComplete());
    }
};

QTEST_MAIN(TestModels)
#include "tst_models.moc"
