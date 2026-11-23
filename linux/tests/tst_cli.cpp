#include "cli.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QtTest>
#include <optional>

#include "models.h"

// Starts a call with a context that dies on return, and waits for its reply.
static Reply await(const std::function<void(QObject *, Done)> &call)
{
    QObject context;
    std::optional<Reply> reply;
    call(&context, [&](const Reply &r) { reply = r; });
    [&] { QTRY_VERIFY_WITH_TIMEOUT(reply.has_value(), 10000); }();
    return reply.value_or(Reply{});
}

static Reply execute(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env = {},
                     const QByteArray &input = {})
{
    return await([&](QObject *context, Done done) { Cli::execute(program, args, env, input, context, done); });
}

static Reply sh(const QString &script, const QStringList &args = {}, const QByteArray &input = {})
{
    return execute("/bin/sh", QStringList{"-c", script, "schmear"} + args, {}, input);
}

static Reply run(const QStringList &args, const QByteArray &input = {})
{
    return await([&](QObject *context, Done done) { Cli::run(args, input, context, done); });
}

static void writeFile(const QString &path, const QByteArray &content)
{
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly) || f.write(content) != content.size())
        qFatal("cannot write %s", qPrintable(path));
}

class TestCli : public QObject {
    Q_OBJECT
    std::optional<QTemporaryDir> m_home;

    QString home() const { return m_home->path(); }
    void writeProfile() { writeFile(home() + "/.profile", "export PATH=\"" + home().toUtf8() + "/bin:$PATH\"\n"); }

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
        const QString schmear = home() + "/bin/schmear";
        writeFile(schmear, "#!/bin/sh\n"
                           "case \"$1\" in\n"
                           "usage) cat '" SCHMEAR_FIXTURES "/snapshot.json' ;;\n"
                           "tiers) cat > \"$HOME/stdin\" ;;\n"
                           "esac\n");
        QVERIFY(QFile::setPermissions(schmear, QFile::permissions(schmear) | QFile::ExeOwner));
    }

    void returnsStdout()
    {
        const Reply r = sh(R"(printf '%s' "$1")", {"hello world"});
        QCOMPARE(r.status, Reply::Ok);
        QCOMPARE(r.out, QByteArray("hello world"));
    }

    void passesStdin()
    {
        const Reply r = sh("cat", {}, R"({"a":1})");
        QCOMPARE(r.status, Reply::Ok);
        QCOMPARE(r.out, QByteArray(R"({"a":1})"));
    }

    void largeOutputDoesNotDeadlock()
    {
        const Reply r = sh("head -c 1000000 /dev/zero");
        QCOMPARE(r.status, Reply::Ok);
        QCOMPARE(r.out.size(), 1000000);
    }

    void nonZeroExitGivesTrimmedStderr()
    {
        const Reply r = sh("echo 'schmear: tier 1 is empty' >&2; exit 1");
        QCOMPARE(r.status, Reply::Failed);
        QCOMPARE(r.error, QStringLiteral("schmear: tier 1 is empty"));
    }

    void emptyStderrGivesExitStatus()
    {
        const Reply r = sh("exit 3");
        QCOMPARE(r.status, Reply::Failed);
        QCOMPARE(r.error, QStringLiteral("schmear exited with status 3"));
    }

    void exit127IsNotInstalled()
    {
        const Reply r = sh("exit 127");
        QCOMPARE(r.status, Reply::NotInstalled);
        QCOMPARE(r.error, QStringLiteral("schmear is not on your login shell's PATH: npm i -g schmear"));
    }

    void envWithoutSchmearOnPathIsNotInstalled()
    {
        QProcessEnvironment env;
        env.insert("PATH", "/nonexistent");
        QCOMPARE(execute("/usr/bin/env", {"schmear"}, env).status, Reply::NotInstalled);
    }

    void launchUsesTheGivenEnvironment()
    {
        QProcessEnvironment env;
        env.insert("XDG_CONFIG_HOME", "/cfg");
        const Reply r = execute("/bin/sh", {"-c", R"(printf '%s' "$XDG_CONFIG_HOME")"}, env);
        QCOMPARE(r.status, Reply::Ok);
        QCOMPARE(r.out, QByteArray("/cfg"));
    }

    void loginEnvironmentIsTheEntriesAfterTheLastMarker()
    {
        const auto env = [](std::initializer_list<std::pair<QString, QString>> entries) {
            QProcessEnvironment e;
            for (const auto &[k, v] : entries)
                e.insert(k, v);
            return std::optional(e);
        };
        QCOMPARE(Cli::loginEnvironment(QByteArrayLiteral("motd\nstale=1\0__SCHMEAR_ENV__PATH=/a:/b\0HOME=/h\0")),
                 env({{"PATH", "/a:/b"}, {"HOME", "/h"}}));
        QCOMPARE(Cli::loginEnvironment(QByteArrayLiteral("__SCHMEAR_ENV__PATH=/a\0OPTS=a=b\0MULTI=x\ny\0")),
                 env({{"PATH", "/a"}, {"OPTS", "a=b"}, {"MULTI", "x\ny"}}));
        QCOMPARE(Cli::loginEnvironment(QByteArrayLiteral("PATH=/a\0")), std::nullopt);
        QCOMPARE(Cli::loginEnvironment(QByteArrayLiteral("__SCHMEAR_ENV__HOME=/h\0")), std::nullopt);
        QCOMPARE(Cli::loginEnvironment(""), std::nullopt);
    }

    // schmear finds its config through HOME, so the login read must carry it through.
    void loginEnvironmentKeepsHome()
    {
        const Reply r = execute("/bin/sh", {"-ilc", "printf '\\n__SCHMEAR_ENV__'; exec /usr/bin/env -0"});
        QVERIFY2(r.status == Reply::Ok, qPrintable(r.error));
        const auto env = Cli::loginEnvironment(r.out);
        QVERIFY(env);
        const QByteArray marker = "__SCHMEAR_ENV__";
        QVERIFY2(env->contains("HOME"),
                 qPrintable(QStringLiteral("size %1, markers %2 at %3..%4, HOME= at %5, around HOME: %6, after marker: %7")
                                .arg(r.out.size()).arg(r.out.count(marker)).arg(r.out.indexOf(marker))
                                .arg(r.out.lastIndexOf(marker)).arg(r.out.indexOf("HOME="))
                                .arg(QString::fromUtf8(r.out.mid(qMax(0, int(r.out.indexOf("HOME=")) - 60), 160)).replace(QChar(0), '|'))
                                .arg(QString::fromUtf8(r.out.mid(r.out.lastIndexOf(marker), 200)).replace(QChar(0), '|'))));
        QCOMPARE(env->value("HOME"), home());
    }

    void runsSchmearInTheLoginEnvironment()
    {
        writeProfile();
        const Reply usage = run({"usage", "--json"});
        QVERIFY2(usage.status == Reply::Ok, qPrintable(usage.error));
        QString error;
        const auto snapshot = decodeSnapshot(usage.out, &error);
        QVERIFY2(snapshot, qPrintable(error));
        QCOMPARE(snapshot->readings.size(), 2);

        const QByteArray tiers = R"([["a:b@c"]])";
        const Reply set = run({"tiers", "set"}, tiers);
        QVERIFY2(set.status == Reply::Ok, qPrintable(set.error));
        QFile stdinFile(home() + "/stdin");
        QVERIFY(stdinFile.open(QIODevice::ReadOnly));
        QCOMPARE(stdinFile.readAll(), tiers);
    }

    void notInstalledClearsTheCache()
    {
        QCOMPARE(run({"usage", "--json"}).status, Reply::NotInstalled);
        writeProfile();
        const Reply r = run({"usage", "--json"});
        QVERIFY2(r.status == Reply::Ok, qPrintable(r.error));
    }
};

QTEST_MAIN(TestCli)
#include "tst_cli.moc"
