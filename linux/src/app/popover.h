#pragma once

#include <QLabel>
#include <QWidget>

class QScrollArea;
class Store;

inline void setForeground(QWidget *w, const QColor &color)
{
    QPalette p = w->palette();
    p.setColor(QPalette::WindowText, color);
    w->setPalette(p);
}

// Elides at paint time, so it never forces its row wider and offscreen renders are correct.
class ElidedLabel : public QLabel {
public:
    ElidedLabel(const QString &text, Qt::TextElideMode mode, QWidget *parent = nullptr);
    QSize minimumSizeHint() const override;

protected:
    void paintEvent(QPaintEvent *event) override;

private:
    Qt::TextElideMode m_mode;
};

class RemainingBar : public QWidget {
public:
    explicit RemainingBar(double remaining, QWidget *parent = nullptr);

protected:
    void paintEvent(QPaintEvent *event) override;

private:
    double m_remaining;
};

// The menu bar popover's content: header, error, subscriptions, next lane per tier, delegations, footer.
class PopoverWindow : public QWidget {
    Q_OBJECT
public:
    PopoverWindow(Store *store, bool scrolls, QWidget *parent = nullptr);
    void setNotice(const QString &notice);

signals:
    void editTiersRequested();

protected:
    void changeEvent(QEvent *event) override;

private:
    void rebuild();
    QWidget *buildContent();

    Store *m_store;
    QScrollArea *m_scroll = nullptr;
    QWidget *m_content = nullptr;
    QString m_notice, m_loginError;
};
