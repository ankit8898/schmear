#include "cli.h"

#include <QProcess>

namespace {

std::optional<QProcessEnvironment> cachedEnvironment;

QString trimmed(const QByteArray &data)
{
    return QString::fromUtf8(data).trimmed();
}

// Calls exited once the process exits, or done with a Failed reply if it cannot start.
void spawn(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env,
           const QByteArray &input, QObject *context, const Done &done, std::function<void(QProcess *)> exited)
{
    auto *process = new QProcess(context);
    if (env)
        process->setProcessEnvironment(*env);
    // ~QProcess emits finished while it kills the child, and ~QWidget deletes children before ~QObject cuts the
    // context's connections; destroyed comes first in both.
    QObject::connect(context, &QObject::destroyed, process, [process] { process->disconnect(); });
    QObject::connect(process, &QProcess::errorOccurred, process, [=](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart)
            return;
        done({Reply::Failed, {}, QStringLiteral("could not start %1: %2").arg(program, process->errorString())});
        process->deleteLater();
    });
    QObject::connect(process, &QProcess::finished, process, [=] {
        exited(process);
        process->deleteLater();
    });
    process->start(program, args);
    process->write(input);
    process->closeWriteChannel();
}

}

void Cli::execute(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env,
                  const QByteArray &input, QObject *context, Done done)
{
    spawn(program, args, env, input, context, done, [done](QProcess *process) {
        const bool normal = process->exitStatus() == QProcess::NormalExit;
        const int code = process->exitCode();
        if (normal && code == 0)
            return done({Reply::Ok, process->readAllStandardOutput(), {}});
        if (normal && code == 127)
            return done({Reply::NotInstalled, {}, QStringLiteral("schmear is not on your login shell's PATH: npm i -g schmear")});
        QString error = trimmed(process->readAllStandardError());
        if (error.isEmpty())
            error = normal ? QStringLiteral("schmear exited with status %1").arg(code)
                           : QStringLiteral("schmear was stopped by a signal");
        done({Reply::Failed, {}, error});
    });
}

void Cli::run(const QStringList &args, const QByteArray &input, QObject *context, Done done)
{
    const auto schmear = [=](const QProcessEnvironment &env) {
        execute(QStringLiteral("/usr/bin/env"), QStringList{QStringLiteral("schmear")} + args, env, input, context,
                [done](const Reply &reply) {
                    if (reply.status == Reply::NotInstalled)
                        clearLoginEnvironment();
                    done(reply);
                });
    };
    if (cachedEnvironment)
        return schmear(*cachedEnvironment);

    QString shell = qEnvironmentVariable("SHELL");
    if (shell.isEmpty())
        shell = QStringLiteral("/bin/sh");
    const QStringList shellArgs{QStringLiteral("-ilc"), QStringLiteral("printf '\\n__SCHMEAR_ENV__'; exec /usr/bin/env -0")};
    spawn(shell, shellArgs, std::nullopt, {}, context, done, [=](QProcess *process) {
        std::optional<QProcessEnvironment> env;
        if (process->exitStatus() == QProcess::NormalExit && process->exitCode() == 0)
            env = loginEnvironment(process->readAllStandardOutput());
        if (!env)
            return done({Reply::Failed, {},
                         QStringLiteral("could not read the environment from %1 -ilc: %2")
                             .arg(shell, trimmed(process->readAllStandardError()))});
        cachedEnvironment = env;
        schmear(*env);
    });
}

std::optional<QProcessEnvironment> Cli::loginEnvironment(const QByteArray &output)
{
    static const QByteArray marker = "__SCHMEAR_ENV__";
    const qsizetype at = output.lastIndexOf(marker);
    if (at < 0)
        return std::nullopt;
    QProcessEnvironment env;
    for (const QByteArray &entry : output.mid(at + marker.size()).split('\0')) {
        const qsizetype eq = entry.indexOf('=');
        if (eq >= 0)
            env.insert(QString::fromUtf8(entry.left(eq)), QString::fromUtf8(entry.mid(eq + 1)));
    }
    if (!env.contains(QStringLiteral("PATH")))
        return std::nullopt;
    return env;
}

void Cli::clearLoginEnvironment()
{
    cachedEnvironment.reset();
}
