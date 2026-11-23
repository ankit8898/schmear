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

    void decodesTiers()
    {
        QString error;
        const auto t = decodeTiers(fixture("tiers"), &error);
        QVERIFY2(t, qPrintable(error));
        QCOMPARE(t->source, QStringLiteral("config"));
        QCOMPARE(t->tiers[1], (QStringList{"claude:sonnet@high", "codex:gpt-5@medium"}));
        QCOMPARE(t->laneKeys.size(), 3);
        QCOMPARE(t->offered.value("codex"), QStringList{"gpt-5"});
        QVERIFY(!t->offered.contains("agy-gemini"));
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
