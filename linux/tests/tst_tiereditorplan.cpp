#include "tiereditorplan.h"

#include <QtTest>

static QList<QList<TierEntry>> entries(const QList<QStringList> &tiers)
{
    QList<QList<TierEntry>> out;
    for (const QStringList &tier : tiers) {
        QList<TierEntry> row;
        for (const QString &spec : tier)
            row.append(TierEntry::fromSpec(spec));
        out.append(row);
    }
    return out;
}

static TiersDoc doc(const QString &source)
{
    TiersDoc d;
    d.source = source;
    d.maxTasks = 50;
    d.tiers = {{"claude:haiku@medium"}, {"claude:sonnet@high", "codex:gpt-5@medium"}};
    return d;
}

static QList<QStringList> argsOf(const QList<Command> &steps)
{
    QList<QStringList> out;
    for (const Command &c : steps)
        out.append(c.args);
    return out;
}

class TestTierEditorPlan : public QObject {
    Q_OBJECT
private slots:
    void onlyTheLimitChangedOnDefaults()
    {
        const TiersDoc d = doc("default");
        const auto steps = tierEditorSteps(d, entries(d.tiers), 8);
        QCOMPARE(argsOf(steps), (QList<QStringList>{{"max-tasks", "8"}}));
    }

    void editedTiersAreSet()
    {
        const TiersDoc d = doc("default");
        const auto edited = entries({{"claude:haiku@low"}, d.tiers[1]});
        auto steps = tierEditorSteps(d, edited, 50);
        QCOMPARE(argsOf(steps), (QList<QStringList>{{"tiers", "set"}}));
        QCOMPARE(steps[0].input, tiersJson(edited));
        steps = tierEditorSteps(d, edited, 8);
        QCOMPARE(argsOf(steps), (QList<QStringList>{{"max-tasks", "8"}, {"tiers", "set"}}));
    }

    void nothingChanged()
    {
        const TiersDoc d = doc("default");
        QVERIFY(tierEditorSteps(d, entries(d.tiers), 50).isEmpty());
    }

    void customSourceUnchanged()
    {
        const TiersDoc d = doc("config");
        QVERIFY(tierEditorSteps(d, entries(d.tiers), 50).isEmpty());
    }
};

QTEST_APPLESS_MAIN(TestTierEditorPlan)
#include "tst_tiereditorplan.moc"
