#include "cli.h"

#include <QProcess>
#include <QTimer>

namespace {

std::optional<QProcessEnvironment> cachedEnvironment;

QString trimmed(const QByteArray &data)
{
    return QString::fromUtf8(data).trimmed();
}

QString timeoutError(const QString &command, int timeoutMs)
{
    return QStringLiteral("%1 timed out after %2 s").arg(command, QString::number(timeoutMs / 1000.0));
}

QString commandLabel(const QString &program, const QStringList &args)
{
    if (program == QLatin1String("/usr/bin/env") && !args.isEmpty())
        return args.join(QLatin1Char(' '));
    return args.isEmpty() ? program : program + QLatin1Char(' ') + args.join(QLatin1Char(' '));
}

// Calls exited once the process exits, or done with a Failed reply if it cannot start or times out.
void spawn(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env,
           const QByteArray &input, QObject *context, const Done &done, std::function<void(QProcess *)> exited,
           int timeoutMs, const QString &timeoutMessage)
{
    auto *process = new QProcess(context);
    auto *timer = new QTimer(process);
    timer->setSingleShot(true);
    if (env)
        process->setProcessEnvironment(*env);
    // ~QProcess emits finished while it kills the child, and ~QWidget deletes children before ~QObject cuts the
    // context's connections; destroyed comes first in both.
    QObject::connect(context, &QObject::destroyed, process, [process, timer] {
        timer->stop();
        process->disconnect();
    });
    QObject::connect(timer, &QTimer::timeout, process, [=] {
        process->disconnect();
        if (process->state() == QProcess::NotRunning) {
            process->deleteLater();
        } else {
            QObject::connect(process, &QProcess::finished, process, &QObject::deleteLater);
            process->kill();
        }
        done({Reply::Failed, {}, timeoutMessage});
    });
    QObject::connect(process, &QProcess::errorOccurred, process, [=](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart)
            return;
        timer->stop();
        done({Reply::Failed, {}, QStringLiteral("could not start %1: %2").arg(program, process->errorString())});
        process->deleteLater();
    });
    QObject::connect(process, &QProcess::finished, process, [=] {
        timer->stop();
        exited(process);
        process->deleteLater();
    });
    if (timeoutMs > 0)
        timer->start(timeoutMs);
    process->start(program, args);
    process->write(input);
    process->closeWriteChannel();
}

}

void Cli::execute(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env,
                  const QByteArray &input, QObject *context, Done done, int timeoutMs)
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
    }, timeoutMs, timeoutError(commandLabel(program, args), timeoutMs));
}

void Cli::run(const QStringList &args, const QByteArray &input, QObject *context, Done done, int timeoutMs)
{
    const QStringList envArgs = QStringList{QStringLiteral("schmear")} + args;
    const auto schmear = [=](const QProcessEnvironment &env) {
        execute(QStringLiteral("/usr/bin/env"), envArgs, env, input, context,
                [done](const Reply &reply) {
                    if (reply.status == Reply::NotInstalled)
                        clearLoginEnvironment();
                    done(reply);
                }, timeoutMs);
    };
    if (cachedEnvironment)
        return schmear(*cachedEnvironment);

    QString shell = qEnvironmentVariable("SHELL");
    if (shell.isEmpty())
        shell = QStringLiteral("/bin/sh");
    const QStringList shellArgs{QStringLiteral("-ilc"), QStringLiteral("printf '\\0__SCHMEAR_ENV__\\0'; exec /usr/bin/env -0")};
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
    }, timeoutMs, timeoutError(envArgs.join(QLatin1Char(' ')), timeoutMs));
}

std::optional<QProcessEnvironment> Cli::loginEnvironment(const QByteArray &output)
{
    // NUL-framed because an env value can hold the marker text (a GitHub runner's does) but never a NUL.
    static const QByteArray marker = QByteArrayLiteral("\0__SCHMEAR_ENV__\0");
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
