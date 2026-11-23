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
    const Snapshot *snapshot() const;  // nullptr when none
    QString error() const;             // empty when none
    bool refreshing() const;
    double now() const;                // epoch seconds
signals:
    void changed();

private:
    std::optional<Snapshot> m_snapshot;
    QString m_error;
    bool m_refreshing = false;
    double m_now;
    QTimer m_timer;
};
