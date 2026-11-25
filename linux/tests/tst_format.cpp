#include "format.h"

#include <QFile>
#include <QtTest>

static const double now = 1700000000;

static double ms(double secondsFromNow)
{
    return (now + secondsFromNow) * 1000;
}

static Snapshot fixture(const char *name = "snapshot")
{
    QFile f(QStringLiteral(SCHMEAR_FIXTURES "/%1.json").arg(QLatin1String(name)));
    if (!f.open(QIODevice::ReadOnly))
        qFatal("cannot open fixture");
    QString error;
    const auto s = decodeSnapshot(f.readAll(), &error);
    if (!s)
        qFatal("%s", qPrintable(error));
    return *s;
}

static Snapshot::Task task(const QString &status, double startedAt)
{
    Snapshot::Task t;
    t.status = status;
    t.startedAt = startedAt;
    return t;
}

class TestFormat : public QObject {
    Q_OBJECT
private slots:
    void relativeTimes()
    {
        QCOMPARE(Format::relative(ms(-180), now), QStringLiteral("3m ago"));
        QCOMPARE(Format::relative(ms(-10), now), QStringLiteral("just now"));
        QCOMPARE(Format::relative(ms(-7200), now), QStringLiteral("2h ago"));
        QCOMPARE(Format::relative(ms(2 * 86400 + 3 * 3600), now), QStringLiteral("in 2d 3h"));
        QCOMPARE(Format::relative(ms(5400), now), QStringLiteral("in 1h 30m"));
        QCOMPARE(Format::relative(ms(0), now), QStringLiteral("now"));
        QCOMPARE(Format::relative(ms(59), now), QStringLiteral("now"));
        QCOMPARE(Format::relative(ms(-59), now), QStringLiteral("just now"));
        QCOMPARE(Format::relative(ms(61), now), QStringLiteral("in 1m"));
        QCOMPARE(Format::relative(ms(-61), now), QStringLiteral("1m ago"));
    }

    void windowLines()
    {
        Snapshot::Window w{0.37, ms(2 * 86400 + 3 * 3600), 168, std::nullopt};
        QCOMPARE(Format::windowLine(w, now), QStringLiteral("7d · 37% left · resets in 2d 3h"));
        const Snapshot::Window shortW{0.5, std::nullopt, 5, std::nullopt};
        QCOMPARE(Format::windowLine(shortW, now), QStringLiteral("5h · 50% left · resets —"));
        const Snapshot::Window past{1, ms(-180), 5, std::nullopt};
        QCOMPARE(Format::windowLine(past, now), QStringLiteral("5h · 100% left · resets 3m ago"));
        w.projectedUnused = 0.124;
        QCOMPARE(Format::windowLine(w, now), QStringLiteral("7d · 37% left · resets in 2d 3h · ~12% unused"));
        w.projectedUnused = 0.004;
        QCOMPARE(Format::windowLine(w, now), QStringLiteral("7d · 37% left · resets in 2d 3h"));
        w.projectedUnused = 0;
        QCOMPARE(Format::windowLine(w, now), QStringLiteral("7d · 37% left · resets in 2d 3h"));
        QCOMPARE(Format::windowLabel({0, std::nullopt, 36, std::nullopt}), QStringLiteral("36h"));
    }

    void pace()
    {
        QCOMPARE(Format::pace(1.4249), QStringLiteral("1.42"));
        QCOMPARE(Format::pace(std::nullopt), QStringLiteral("—"));
    }

    void taskElapsed()
    {
        const auto tasks = fixture().tasks;
        QCOMPARE(Format::elapsed(tasks[0], now), QStringLiteral("running 4m"));
        QCOMPARE(Format::elapsed(tasks[1], now), QStringLiteral("done 12m ago"));
        QCOMPARE(Format::elapsed(tasks[2], now), QStringLiteral("lost 2h 46m ago"));
        auto noQuota = tasks[1];
        noQuota.status = QStringLiteral("no_quota");
        QCOMPARE(Format::elapsed(noQuota, now), QStringLiteral("no quota 12m ago"));
    }

    void cost()
    {
        QCOMPARE(Format::cost(0.0123), QStringLiteral("$0.0123"));
        QCOMPARE(Format::cost(0), QStringLiteral("$0.0000"));
    }

    void taskDetails()
    {
        const auto tasks = fixture().tasks;
        QCOMPARE(Format::taskDetails(tasks[0], now), QStringLiteral("claude:sonnet · tier 2 · running 4m"));
        QCOMPARE(Format::taskDetails(tasks[1], now), QStringLiteral("claude:haiku · tier 1 · done 12m ago · $0.0123"));
        QCOMPARE(Format::taskDetails(tasks[2], now), QStringLiteral("tier 1 · lost 2h 46m ago"));
    }

    void nextText()
    {
        const auto s = fixture();
        QCOMPARE(Format::nextText(s.next[0]), QStringLiteral("claude:haiku (medium)"));
        QCOMPARE(Format::nextText(s.next[1]), QStringLiteral("none"));
        QCOMPARE(Format::nextText({3, QStringLiteral("codex:gpt-5"), std::nullopt}), QStringLiteral("codex:gpt-5"));
    }

    void trayRules()
    {
        const auto s = fixture();
        QCOMPARE(Format::runningCount(&s), 1);
        QVERIFY(Format::underspent(&s));
        QVERIFY(!Format::attention(&s, false));
        QCOMPARE(Format::trayLabel(&s), QStringLiteral("schmear, 1 running, quota to spend"));
        QCOMPARE(Format::runningCount(nullptr), 0);
        QVERIFY(!Format::underspent(nullptr));
        QVERIFY(!Format::attention(nullptr, false));
        QCOMPARE(Format::trayLabel(nullptr), QStringLiteral("schmear"));
    }

    void attentionRules()
    {
        const auto healthy = fixture();
        QVERIFY(!Format::attention(&healthy, false));
        QVERIFY(!Format::attention(nullptr, false));

        // 1. CLI not installed
        QVERIFY(Format::attention(nullptr, true));
        QVERIFY(Format::attention(&healthy, true));
        QCOMPARE(Format::trayLabel(nullptr, true), QStringLiteral("schmear, needs attention"));

        // 2. Any host not ok
        auto okHosts = healthy;
        okHosts.hosts = {{QStringLiteral("claude"), QStringLiteral("ok")},
                         {QStringLiteral("codex"), QStringLiteral("ok")}};
        QVERIFY(!Format::attention(&okHosts, false));
        QVERIFY(Format::disconnectedHosts(okHosts).isEmpty());

        auto staleHost = okHosts;
        staleHost.hosts[1].status = QStringLiteral("stale");
        staleHost.hosts.append({QStringLiteral("agy"), QStringLiteral("missing")});
        QVERIFY(Format::attention(&staleHost, false));
        QCOMPARE(Format::disconnectedHosts(staleHost), (QStringList{QStringLiteral("Codex"), QStringLiteral("Antigravity")}));
        QCOMPARE(Format::trayLabel(&staleHost, false), QStringLiteral("schmear, needs attention, 1 running, quota to spend"));

        // 3. Snapshot present with no reading having a pool (skipped, pool-less, or empty readings)
        auto allSkipped = healthy;
        allSkipped.readings[0].skipped = QStringLiteral("not configured");
        QVERIFY(Format::attention(&allSkipped, false));

        auto poolless = healthy;
        poolless.readings[0].pools.clear();
        QVERIFY(Format::attention(&poolless, false));

        auto emptyReadings = healthy;
        emptyReadings.readings.clear();
        QVERIFY(Format::attention(&emptyReadings, false));
    }

    void skippedCreditReadingCountsLikeAnySkipped()
    {
        const auto s = fixture("snapshot-credits");
        QVERIFY(!Format::attention(&s, false));
        auto onlySkipped = s;
        onlySkipped.readings = {s.readings[0], s.readings[3]};
        onlySkipped.readings[0].skipped = QStringLiteral("no consent");
        onlySkipped.readings[0].pools.clear();
        QVERIFY(Format::attention(&onlySkipped, false));
    }

    void creditLines()
    {
        const auto r = fixture("snapshot-credits").readings;
        QCOMPARE(Format::creditLine(r[0].pools[0]), QString());
        QCOMPARE(Format::creditLine(r[1].pools[0]), QStringLiteral("$4.20 of $5 left · expires Nov 20"));
        QCOMPARE(Format::creditLine(r[2].pools[0]), QStringLiteral("$300 of $300 left"));
        auto overdrawn = r[2].pools[0];
        overdrawn.usd = Snapshot::Usd{-0.5, 12.345};
        QCOMPARE(Format::creditLine(overdrawn), QStringLiteral("$0 of $12.35 left"));
    }

    void creditReadingsNestUnderTheirAccount()
    {
        const auto accounts = Format::accounts(fixture("snapshot-credits"));
        QStringList titles;
        for (const auto &a : accounts)
            titles << a.title;
        QCOMPARE(titles, (QStringList{"claude@default", "lab · API credits only", "side · API credits only"}));
        QCOMPARE(accounts[0].reading->id, QStringLiteral("claude@default"));
        QCOMPARE(accounts[0].credits.size(), 1);
        QCOMPARE(accounts[0].credits[0].id, QStringLiteral("claude-credits@default"));
        QVERIFY(!accounts[1].reading);
        QCOMPARE(accounts[1].credits[0].id, QStringLiteral("gemini-credits@lab"));
        QCOMPARE(accounts[2].credits[0].skipped, std::optional<QString>("Console session side expired."));
    }

    void cliVersionMinimum()
    {
        const auto v = [](const char *s) { return std::optional<QString>(QString::fromLatin1(s)); };
        QVERIFY(Format::cliTooOld(std::nullopt));
        QVERIFY(Format::cliTooOld(v("0.3.1")));
        QVERIFY(Format::cliTooOld(v("garbage")));
        QVERIFY(Format::cliTooOld(v("0.3.9-rc.1")));
        QVERIFY(!Format::cliTooOld(v("0.4.0")));
        QVERIFY(!Format::cliTooOld(v("0.10.0")));
        QVERIFY(!Format::cliTooOld(v("1.0.0")));
        QVERIFY(!Format::cliTooOld(v("0.4.0-rc.1")));
    }

    void cliNoticeStates()
    {
        QCOMPARE(Format::cliNotice(std::optional<QString>("0.4.0")), QString());
        QCOMPARE(Format::cliNotice(std::nullopt),
                 QStringLiteral("schmear older than 0.4.0 is too old for this app; it needs 0.4.0 or later."));
        QCOMPARE(Format::cliNotice(std::optional<QString>("0.3.1")),
                 QStringLiteral("schmear 0.3.1 is too old for this app; it needs 0.4.0 or later."));

        auto s = fixture();
        QCOMPARE(s.cliVersion, std::optional<QString>("0.4.0"));
        QVERIFY(!Format::attention(&s, false));
        s.cliVersion.reset();
        QVERIFY(Format::attention(&s, false));
    }

    void hostNames()
    {
        QCOMPARE(Format::hostName(QStringLiteral("claude")), QStringLiteral("Claude Code"));
        QCOMPARE(Format::hostName(QStringLiteral("codex")), QStringLiteral("Codex"));
        QCOMPARE(Format::hostName(QStringLiteral("grok")), QStringLiteral("Grok"));
        QCOMPARE(Format::hostName(QStringLiteral("agy")), QStringLiteral("Antigravity"));
        QCOMPARE(Format::hostName(QStringLiteral("other")), QStringLiteral("other"));
    }

    void status()
    {
        using S = Format::Status;
        const auto ok = Format::status(QStringLiteral("ok"));
        QCOMPARE(ok.kind, S::Ok);
        QCOMPARE(ok.text, QStringLiteral("ok"));
        const auto out = Format::status(QStringLiteral("out: 5% left"));
        QCOMPARE(out.kind, S::Out);
        QCOMPARE(out.text, QStringLiteral("5% left"));
        const auto skipped = Format::status(QStringLiteral("skipped: no token"));
        QCOMPARE(skipped.kind, S::Skipped);
        QCOMPARE(skipped.text, QStringLiteral("no token"));
        const auto other = Format::status(QStringLiteral("weird"));
        QCOMPARE(other.kind, S::Other);
        QCOMPARE(other.text, QStringLiteral("weird"));
    }

    void nothingConfigured()
    {
        auto s = fixture();
        QVERIFY(!Format::nothingConfigured(s));
        s.readings[0].skipped = QStringLiteral("not configured");
        QVERIFY(Format::nothingConfigured(s));
        s.readings.clear();
        QVERIFY(!Format::nothingConfigured(s));
    }

    void lonePool()
    {
        auto r = fixture().readings[0];
        QVERIFY(!Format::lonePool(r));
        r.pools.removeLast();
        QVERIFY(Format::lonePool(r));
        r.pools[0].id = QStringLiteral("other");
        QVERIFY(!Format::lonePool(r));
    }

    void shownTasks()
    {
        Snapshot s;
        for (int i = 0; i < 12; ++i)
            s.tasks << task(i % 4 == 0 ? QStringLiteral("running") : QStringLiteral("done"), i);
        const auto shown = Format::shownTasks(s);
        QCOMPARE(shown.size(), 10);
        QList<double> started;
        for (const auto &t : shown)
            started << t.startedAt;
        QCOMPARE(started, (QList<double>{8, 4, 0, 11, 10, 9, 7, 6, 5, 3}));
    }
};

QTEST_MAIN(TestFormat)
#include "tst_format.moc"
