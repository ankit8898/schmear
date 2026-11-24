#pragma once

#include <QObject>
#include <QString>
#include <QTimer>
#include <optional>

#include "models.h"

// The latest `schmear usage --json`, refreshed every 60 s.
class Store : public QObject {
    Q_OBJECT
public:
    explicit Store(QObject *parent = nullptr);
    // For review renders: never runs the CLI.
    Store(Snapshot snapshot, double now, QObject *parent = nullptr);
    void start();
    // A call while one runs only updates now, so refreshes never overlap.
    void refresh();
    // Runs `schmear init --yes`; on success sets reconnectHint and refreshes.
    void reconnect();
    void dismissReconnectHint();
    const Snapshot *snapshot() const;  // nullptr when none
    QString error() const;             // empty when none
    bool notInstalled() const;
    bool refreshing() const;
    bool reconnecting() const;
    QString reconnectError() const;    // empty when none
    QString reconnectHint() const;     // empty when none
    double now() const;                // epoch seconds
signals:
    void changed();

private:
    std::optional<Snapshot> m_snapshot;
    QString m_error;
    bool m_notInstalled = false;
    bool m_refreshing = false;
    bool m_reconnecting = false;
    QString m_reconnectError;
    QString m_reconnectHint;
    double m_now;
    QTimer m_timer;
};
