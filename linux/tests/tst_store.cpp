#include "store.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QtTest>
#include <optional>

#include "cli.h"
#include "format.h"

static void writeFile(const QString &path, const QByteArray &content)
{
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly) || f.write(content) != content.size())
        qFatal("cannot write %s", qPrintable(path));
}

class TestStore : public QObject {
    Q_OBJECT
    std::optional<QTemporaryDir> m_home;

    QString home() const { return m_home->path(); }
    void writeSchmear(const QByteArray &body)
    {
        const QString schmear = home() + "/bin/schmear";
        writeFile(schmear, "#!/bin/sh\n" + body + "\n");
        QVERIFY(QFile::setPermissions(schmear, QFile::permissions(schmear) | QFile::ExeOwner));
    }
    static void refreshAndWait(Store &store)
    {
        store.refresh();
        QTRY_VERIFY_WITH_TIMEOUT(!store.refreshing(), 10000);
    }

private slots:
    void init()
    {
        Cli::clearLoginEnvironment();
        m_home.emplace();
        QVERIFY(m_home->isValid());
        qputenv("SHELL", "/bin/sh");
        qputenv("HOME", home().toUtf8());
        qputenv("PATH", "/usr/bin:/bin");
        QVERIFY(QDir(home()).mkdir("bin"));
        writeFile(home() + "/.profile", "export PATH=\"" + home().toUtf8() + "/bin:$PATH\"\n");
        writeSchmear("sleep 0.3; echo call >> \"$HOME/calls\"; cat '" SCHMEAR_FIXTURES "/snapshot.json'");
    }

    void refreshesNeverOverlap()
    {
        Store store;
        store.refresh();
        store.refresh();
        QTRY_VERIFY_WITH_TIMEOUT(!store.refreshing(), 10000);
        QFile calls(home() + "/calls");
        QVERIFY(calls.open(QIODevice::ReadOnly));
        QCOMPARE(calls.readAll().count('\n'), 1);
        QVERIFY(store.snapshot());
        QCOMPARE(store.snapshot()->readings.size(), 2);
        QVERIFY(store.error().isEmpty());
    }

    void failureKeepsTheSnapshot()
    {
        Store store;
        refreshAndWait(store);
        QVERIFY(store.snapshot());
        writeSchmear("echo boom >&2; exit 1");
        refreshAndWait(store);
        QVERIFY(store.snapshot());
        QCOMPARE(store.snapshot()->readings.size(), 2);
        QCOMPARE(store.error(), QStringLiteral("boom"));
    }

    void notInstalledClearsTheSnapshot()
    {
        Store store;
        QVERIFY(!store.notInstalled());
        refreshAndWait(store);
        QVERIFY(store.snapshot());
        QVERIFY(!store.notInstalled());
        writeSchmear("exit 127");
        refreshAndWait(store);
        QVERIFY(!store.snapshot());
        QVERIFY(store.notInstalled());
        QCOMPARE(store.error(), QStringLiteral("schmear is not on your login shell's PATH: npm i -g schmear"));
        writeSchmear("cat '" SCHMEAR_FIXTURES "/snapshot.json'");
        refreshAndWait(store);
        QVERIFY(store.snapshot());
        QVERIFY(!store.notInstalled());
    }

    void reconnectSuccessSetsHintAndRefreshes()
    {
        writeSchmear(
            "case \"$1\" in\n"
            "usage)\n"
            "  echo usage >> \"$HOME/usage-calls\"\n"
            "  if [ -f \"$HOME/fixed\" ]; then\n"
            "    cat '" SCHMEAR_FIXTURES "/snapshot.json'\n"
            "  else\n"
            "    cat '" SCHMEAR_FIXTURES "/snapshot-hosts.json'\n"
            "  fi\n"
            "  ;;\n"
            "init)\n"
            "  echo \"$*\" > \"$HOME/init-args\"\n"
            "  touch \"$HOME/fixed\"\n"
            "  ;;\n"
            "esac");
        Store store;
        refreshAndWait(store);
        QVERIFY(store.snapshot());
        QCOMPARE(Format::disconnectedHosts(*store.snapshot()),
                 (QStringList{QStringLiteral("Codex"), QStringLiteral("Antigravity")}));

        store.reconnect();
        QVERIFY(store.reconnecting());
        QTRY_VERIFY_WITH_TIMEOUT(!store.reconnecting() && !store.refreshing(), 10000);

        QFile initArgs(home() + "/init-args");
        QVERIFY(initArgs.open(QIODevice::ReadOnly));
        QCOMPARE(initArgs.readAll().trimmed(), QByteArray("init --yes"));
        QFile usageCalls(home() + "/usage-calls");
        QVERIFY(usageCalls.open(QIODevice::ReadOnly));
        QCOMPARE(usageCalls.readAll().count('\n'), 2);
        QVERIFY(store.reconnectError().isEmpty());
        QCOMPARE(store.reconnectHint(),
                 QStringLiteral("Reconnected. Restart Codex, Antigravity to use schmear."));
        QVERIFY(store.snapshot());
        QVERIFY(Format::disconnectedHosts(*store.snapshot()).isEmpty());

        store.dismissReconnectHint();
        QVERIFY(store.reconnectHint().isEmpty());
    }

    void reconnectFailureSetsError()
    {
        writeSchmear(
            "case \"$1\" in\n"
            "usage) cat '" SCHMEAR_FIXTURES "/snapshot-hosts.json' ;;\n"
            "init) echo 'permission denied' >&2; exit 1 ;;\n"
            "esac");
        Store store;
        refreshAndWait(store);
        QVERIFY(store.snapshot());

        store.reconnect();
        QVERIFY(store.reconnecting());
        QTRY_VERIFY_WITH_TIMEOUT(!store.reconnecting(), 10000);

        QCOMPARE(store.reconnectError(), QStringLiteral("permission denied"));
        QVERIFY(store.reconnectHint().isEmpty());
        QCOMPARE(Format::disconnectedHosts(*store.snapshot()),
                 (QStringList{QStringLiteral("Codex"), QStringLiteral("Antigravity")}));
    }
};

QTEST_MAIN(TestStore)
#include "tst_store.moc"
