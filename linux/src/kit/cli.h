#pragma once

#include <QByteArray>
#include <QObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>
#include <functional>
#include <optional>

struct Reply {
    enum Status { Ok, Failed, NotInstalled } status = Failed;
    QByteArray out;  // stdout, when Ok
    QString error;   // shown as is, when not Ok
};
using Done = std::function<void(const Reply &)>;

// Runs the `schmear` CLI with the environment of the user's interactive login shell: a GUI app does not inherit it.
namespace Cli {
// Starts program on a QProcess parented to context, writes input to its stdin and closes it.
// Exit 0 is Ok, exit 127 NotInstalled, anything else Failed with stderr trimmed.
// Calls done exactly once, unless context is destroyed first; that destroys the QProcess, which kills the child.
void execute(const QString &program, const QStringList &args, const std::optional<QProcessEnvironment> &env,
             const QByteArray &input, QObject *context, Done done);
// `/usr/bin/env schmear <args>` in the cached login environment. On NotInstalled it clears the cache.
void run(const QStringList &args, const QByteArray &input, QObject *context, Done done);
// The `env -0` entries after the last NUL-framed "__SCHMEAR_ENV__"; rc files may print before it. Entries without '=' are skipped.
// Nullopt without the marker or without PATH.
std::optional<QProcessEnvironment> loginEnvironment(const QByteArray &output);
void clearLoginEnvironment();
}
