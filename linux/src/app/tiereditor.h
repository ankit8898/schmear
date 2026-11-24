#pragma once

#include <QDialog>
#include <functional>
#include <optional>

#include "models.h"

class QFrame;
class QHBoxLayout;
class QLabel;
class QPushButton;
class QScrollArea;
class Store;

// Edits `schmear tiers` and writes them back with `tiers` and `max-tasks` commands.
class TierEditor : public QDialog {
    Q_OBJECT
public:
    TierEditor(Store *store, bool scrolls, QWidget *parent = nullptr);
    void present();
    void setDoc(const TiersDoc &doc);  // renders: show this doc without running the CLI

protected:
    void changeEvent(QEvent *event) override;

private:
    struct Command { QStringList args; QByteArray input; };
    void load(std::function<void()> then = {});
    void write(QList<Command> commands);
    void runNext(QList<Command> commands, int index, QStringList output);
    void rebuild();
    void updateFooter();
    bool canSave() const;
    QWidget *buildContent();
    QWidget *tierCard(int t);
    QHBoxLayout *entryRow(int t, int e);

    Store *m_store;
    std::optional<TiersDoc> m_doc;
    int m_maxTasks = 0;
    QList<QList<TierEntry>> m_tiers;
    QString m_error, m_message;
    bool m_busy = false;

    QScrollArea *m_scroll = nullptr;
    QWidget *m_content = nullptr;
    QFrame *m_divider;
    QWidget *m_status;
    QLabel *m_statusMark, *m_statusText, *m_working;
    QPushButton *m_reset, *m_save;
};
