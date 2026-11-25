#include "popover.h"

#include <QCheckBox>
#include <QCoreApplication>
#include <QEvent>
#include <QFrame>
#include <QGridLayout>
#include <QPainter>
#include <QPushButton>
#include <QScrollArea>
#include <QScrollBar>
#include <QStyle>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
#include <cmath>

#include "desktop.h"
#include "format.h"
#include "store.h"
#include "theme.h"

namespace {

constexpr int Width = 360;

struct Style {
    QFont headline, callout, strong, caption, section;
    QColor secondary, highlight;
};

QLabel *label(const QString &text, const QFont &font, const QColor &color = {})
{
    auto *l = new QLabel(text);
    l->setFont(font);
    if (color.isValid())
        setForeground(l, color);
    return l;
}

QLabel *wrapped(const QString &text, const QFont &font, const QColor &color = {})
{
    QLabel *l = label(text, font, color);
    l->setWordWrap(true);
    return l;
}

ElidedLabel *elided(const QString &text, Qt::TextElideMode mode, const QFont &font, const QColor &color = {})
{
    auto *l = new ElidedLabel(text, mode);
    l->setFont(font);
    if (color.isValid())
        setForeground(l, color);
    return l;
}

QLabel *glyph(const QString &text, const QString &name, const QFont &font, const QColor &color)
{
    QLabel *l = label(text, font, color);
    l->setAccessibleName(name);
    return l;
}

QFrame *divider(const QPalette &palette)
{
    auto *line = new QFrame;
    line->setFrameShape(QFrame::HLine);
    line->setFrameShadow(QFrame::Plain);
    setForeground(line, lineColor(palette));
    return line;
}

// A glyph beside wrapped text, with the glyph on the first line.
QHBoxLayout *glyphRow(QLabel *mark, QLabel *text)
{
    auto *row = new QHBoxLayout;
    row->setSpacing(8);
    row->addWidget(mark, 0, Qt::AlignTop);
    row->addWidget(text, 1);
    return row;
}

QVBoxLayout *section(const QString &title, const Style &s)
{
    auto *box = new QVBoxLayout;
    box->setSpacing(8);
    box->addWidget(label(title, s.section, s.secondary));
    return box;
}

QHBoxLayout *statusLabel(const QString &status, const Style &s)
{
    const Format::Status st = Format::status(status);
    static const QString marks[] = {QStringLiteral("✓"), QStringLiteral("✕"), QStringLiteral("−"), QStringLiteral("?")};
    const QColor colors[] = {Green, Red, s.secondary, s.secondary};
    auto *row = new QHBoxLayout;
    row->setSpacing(3);
    row->addWidget(glyph(marks[st.kind], st.text, s.caption, colors[st.kind]));
    row->addWidget(label(st.text, s.caption));
    return row;
}

QVBoxLayout *poolView(const Snapshot::Pool &pool, const QString &title, double now, const Style &s)
{
    auto *box = new QVBoxLayout;
    box->setSpacing(4);
    auto *row = new QHBoxLayout;
    row->setSpacing(6);
    if (!title.isEmpty())
        row->addWidget(label(title, s.callout));
    if (!pool.models.isEmpty())
        row->addWidget(elided(pool.models.join(QStringLiteral(", ")), Qt::ElideRight, s.caption, s.secondary));
    row->addStretch();
    row->addWidget(label(QStringLiteral("pace ") + Format::pace(pool.pace), s.caption, s.secondary));
    if (pool.status)
        row->addLayout(statusLabel(*pool.status, s));
    box->addLayout(row);
    if (const QString credit = Format::creditLine(pool); !credit.isEmpty()) {
        box->addWidget(label(credit, s.caption));
        return box;
    }
    for (const auto &window : pool.windows) {
        auto *line = new QHBoxLayout;
        line->setSpacing(8);
        line->addWidget(new RemainingBar(window.remaining));
        line->addWidget(label(Format::windowLine(window, now), s.caption), 1);
        box->addLayout(line);
    }
    return box;
}

QVBoxLayout *connections(const QStringList &hosts, Store *store, const Style &s)
{
    auto *box = new QVBoxLayout;
    box->setSpacing(8);
    auto *lines = new QVBoxLayout;
    lines->setSpacing(4);
    for (const QString &name : hosts)
        lines->addLayout(glyphRow(glyph(QStringLiteral("⚠"), QStringLiteral("Warning"), s.callout, Orange),
                                  wrapped(QStringLiteral("%1 isn't connected to schmear.").arg(name), s.callout)));
    box->addLayout(lines);

    const bool busy = store->reconnecting();
    auto *button = new QPushButton(busy ? QStringLiteral("Reconnecting…") : QStringLiteral("Reconnect"));
    button->setEnabled(!busy);
    QObject::connect(button, &QPushButton::clicked, store, &Store::reconnect);
    box->addWidget(button, 0, Qt::AlignLeft);

    if (!store->reconnectError().isEmpty()) {
        QLabel *err = wrapped(store->reconnectError(), s.caption, s.secondary);
        err->setTextInteractionFlags(Qt::TextSelectableByMouse);
        box->addWidget(err);
    }
    return box;
}

QVBoxLayout *upgradeNotice(const QString &notice, const Style &s)
{
    auto *box = new QVBoxLayout;
    box->setSpacing(8);
    box->addLayout(glyphRow(glyph(QStringLiteral("⚠"), QStringLiteral("Warning"), s.callout, Orange), wrapped(notice, s.callout)));
    QStringList commands;
    for (const QString &command : Format::upgradeCommands())
        commands << QStringLiteral("<code>%1</code>").arg(command.toHtmlEscaped());
    QLabel *list = wrapped(commands.join(QStringLiteral("<br>")), s.callout, s.secondary);
    list->setTextFormat(Qt::RichText);
    list->setTextInteractionFlags(Qt::TextSelectableByMouse);
    box->addWidget(list);
    return box;
}

QVBoxLayout *subscriptions(const Snapshot &snapshot, double now, const Style &s)
{
    QVBoxLayout *box = section(QStringLiteral("Subscriptions"), s);
    if (Format::nothingConfigured(snapshot)) {
        QLabel *empty = wrapped(QStringLiteral("No subscriptions set up. Run <code>schmear init</code> in a terminal."),
                                s.callout, s.secondary);
        empty->setTextFormat(Qt::RichText);
        box->addWidget(empty);
        return box;
    }
    const auto warning = [&](QVBoxLayout *r, const QString &text) {
        r->addLayout(glyphRow(glyph(QStringLiteral("⚠"), QStringLiteral("Warning"), s.caption, s.secondary),
                              wrapped(text, s.caption, s.secondary)));
    };
    for (const auto &account : Format::accounts(snapshot)) {
        auto *r = new QVBoxLayout;
        r->setSpacing(8);
        r->addWidget(label(account.title, s.strong));
        if (const auto &reading = account.reading; reading && reading->skipped) {
            r->addWidget(label(*reading->skipped, s.caption, s.secondary));
        } else if (reading) {
            const bool lone = Format::lonePool(*reading);
            for (const auto &pool : reading->pools)
                r->addLayout(poolView(pool, lone ? QString() : pool.id, now, s));
            for (const auto &text : reading->warnings)
                warning(r, text);
        }
        for (const auto &credit : account.credits) {
            if (credit.skipped) {
                warning(r, account.reading ? QStringLiteral("API credits: ") + *credit.skipped : *credit.skipped);
                continue;
            }
            for (const auto &pool : credit.pools)
                r->addLayout(poolView(pool, QStringLiteral("API credits"), now, s));
            for (const auto &text : credit.warnings)
                warning(r, text);
        }
        box->addLayout(r);
    }
    return box;
}

QVBoxLayout *nextByTier(const Snapshot &snapshot, const Style &s)
{
    QVBoxLayout *box = section(QStringLiteral("Next task by tier"), s);
    auto *grid = new QGridLayout;
    grid->setHorizontalSpacing(8);
    grid->setVerticalSpacing(4);
    grid->setColumnStretch(2, 1);
    for (int i = 0; i < snapshot.next.size(); ++i) {
        const auto &next = snapshot.next[i];
        grid->addWidget(label(QStringLiteral("Tier %1").arg(next.tier), s.callout), i, 0);
        grid->addWidget(label(QStringLiteral("→"), s.callout, s.secondary), i, 1);
        grid->addWidget(elided(Format::nextText(next), Qt::ElideMiddle, s.callout, next.lane ? QColor() : s.secondary), i, 2);
    }
    box->addLayout(grid);
    if (!snapshot.notOffered.isEmpty())
        box->addWidget(wrapped(QStringLiteral("Not offered: ") + snapshot.notOffered.join(QStringLiteral(", ")),
                               s.caption, s.secondary));
    return box;
}

QLabel *taskGlyph(const QString &status, const Style &s)
{
    QFont font = s.callout;
    QString mark = QStringLiteral("–");
    QColor color = s.secondary;
    if (status == QLatin1String("running")) {
        mark = QStringLiteral("●");
        color = s.highlight;
    } else if (status == QLatin1String("done")) {
        mark = QStringLiteral("✓");
        color = Green;
    } else if (status == QLatin1String("failed")) {
        mark = QStringLiteral("✕");
        color = Red;
    } else if (status == QLatin1String("lost")) {
        mark = QStringLiteral("?");
        color = Orange;
        font.setBold(true);
    } else if (status == QLatin1String("cancelled")) {
        mark = QStringLiteral("⊘");
    }
    QLabel *l = glyph(mark, status, font, color);
    l->setFixedWidth(16);
    l->setAlignment(Qt::AlignCenter);
    return l;
}

QVBoxLayout *delegations(const Snapshot &snapshot, double now, const Style &s)
{
    QVBoxLayout *box = section(QStringLiteral("Delegations"), s);
    const QList<Snapshot::Task> tasks = Format::shownTasks(snapshot);
    if (tasks.isEmpty())
        box->addWidget(label(QStringLiteral("No delegations in the last 24 hours."), s.callout, s.secondary));
    for (const auto &task : tasks) {
        auto *row = new QWidget;
        row->setToolTip(task.cwd);
        auto *h = new QHBoxLayout(row);
        h->setContentsMargins(0, 0, 0, 0);
        h->setSpacing(8);
        h->addWidget(taskGlyph(task.status, s), 0, Qt::AlignTop);
        auto *text = new QVBoxLayout;
        text->setSpacing(2);
        text->addWidget(elided(task.description, Qt::ElideRight, s.callout));
        text->addWidget(label(Format::taskDetails(task, now), s.caption, s.secondary));
        h->addLayout(text, 1);
        box->addWidget(row);
    }
    return box;
}

}

ElidedLabel::ElidedLabel(const QString &text, Qt::TextElideMode mode, QWidget *parent) : QLabel(text, parent), m_mode(mode)
{
    setToolTip(text);
}

QSize ElidedLabel::minimumSizeHint() const
{
    return {0, QLabel::minimumSizeHint().height()};
}

void ElidedLabel::paintEvent(QPaintEvent *)
{
    QPainter p(this);
    const QRect r = contentsRect();
    p.setPen(palette().color(foregroundRole()));
    p.drawText(r, int(alignment()), fontMetrics().elidedText(text(), m_mode, r.width()));
}

RemainingBar::RemainingBar(double remaining, QWidget *parent) : QWidget(parent), m_remaining(remaining)
{
    setFixedSize(72, 4);
    setAccessibleName(QStringLiteral("%1% left").arg(std::lround(remaining * 100)));
}

void RemainingBar::paintEvent(QPaintEvent *)
{
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setPen(Qt::NoPen);
    p.setBrush(lineColor(palette()));
    p.drawRoundedRect(rect(), 2, 2);
    p.setBrush(palette().color(QPalette::Highlight));
    p.drawRoundedRect(QRectF(0, 0, width() * std::clamp(m_remaining, 0.0, 1.0), height()), 2, 2);
}

PopoverWindow::PopoverWindow(Store *store, bool scrolls, QWidget *parent) : QWidget(parent), m_store(store)
{
    setWindowTitle(QStringLiteral("schmear"));
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    if (scrolls) {
        m_scroll = new QScrollArea;
        m_scroll->setFrameShape(QFrame::NoFrame);
        m_scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        layout->addWidget(m_scroll);
    }
    connect(store, &Store::changed, this, &PopoverWindow::rebuild);
    rebuild();
}

void PopoverWindow::setNotice(const QString &notice)
{
    m_notice = notice;
    rebuild();
}

// Secondary colours are computed from the palette when the content is built.
void PopoverWindow::changeEvent(QEvent *event)
{
    if (event->type() == QEvent::PaletteChange)
        rebuild();
    QWidget::changeEvent(event);
}

// The old content is deleted later: a rebuild can start from one of its own signals (the login checkbox).
void PopoverWindow::rebuild()
{
    QWidget *content = buildContent();
    if (m_scroll) {
        QScrollBar *bar = m_scroll->verticalScrollBar();
        const int position = bar->value();
        if (QWidget *old = m_scroll->takeWidget())
            old->deleteLater();
        const int height = content->hasHeightForWidth() ? content->heightForWidth(Width) : content->sizeHint().height();
        content->resize(Width, height);
        m_scroll->setWidget(content);
        const int barWidth = height > 640 ? style()->pixelMetric(QStyle::PM_ScrollBarExtent) : 0;
        setFixedSize(Width + barWidth, std::min(height, 640));
        bar->setValue(position);
    } else {
        if (m_content) {
            m_content->hide();
            m_content->deleteLater();
        }
        layout()->addWidget(content);
    }
    m_content = content;
}

QWidget *PopoverWindow::buildContent()
{
    const QFont base = font();
    Style s{base, base, base, base, base, secondary(palette()), palette().color(QPalette::Highlight)};
    s.headline.setBold(true);
    s.strong.setWeight(QFont::DemiBold);
    s.caption.setPointSizeF(base.pointSizeF() * 0.85);
    s.section = s.caption;
    s.section.setWeight(QFont::DemiBold);
    s.section.setCapitalization(QFont::AllUppercase);

    auto *content = new QWidget;
    auto *root = new QVBoxLayout(content);
    root->setContentsMargins(16, 16, 16, 16);
    root->setSpacing(14);

    const Snapshot *snapshot = m_store->snapshot();
    const bool refreshing = m_store->refreshing();
    auto *header = new QHBoxLayout;
    header->setSpacing(8);
    header->addWidget(label(QStringLiteral("schmear"), s.headline));
    QString updated;
    if (snapshot)
        updated = QStringLiteral("updated ") + Format::relative(snapshot->at, m_store->now())
                + (refreshing ? QStringLiteral(" · refreshing…") : QString());
    else if (refreshing)
        updated = QStringLiteral("refreshing…");
    if (!updated.isEmpty())
        header->addWidget(label(updated, s.caption, s.secondary));
    header->addStretch();
    auto *refresh = new QToolButton;
    refresh->setIcon(style()->standardIcon(QStyle::SP_BrowserReload));
    refresh->setAutoRaise(true);
    refresh->setToolTip(QStringLiteral("Refresh"));
    refresh->setAccessibleName(refreshing ? QStringLiteral("Refreshing") : QStringLiteral("Refresh"));
    refresh->setEnabled(!refreshing);
    connect(refresh, &QToolButton::clicked, m_store, &Store::refresh);
    header->addWidget(refresh);
    root->addLayout(header);

    if (!m_notice.isEmpty())
        root->addWidget(wrapped(m_notice, s.caption, s.secondary));

    const QString tooOld = snapshot ? Format::cliNotice(snapshot->cliVersion) : QString();
    if (!tooOld.isEmpty())
        root->addLayout(upgradeNotice(tooOld, s));

    if (tooOld.isEmpty() && !m_store->error().isEmpty()) {
        auto *banner = new QVBoxLayout;
        banner->setSpacing(2);
        banner->addLayout(glyphRow(glyph(QStringLiteral("⚠"), QStringLiteral("Warning"), s.callout, Orange),
                                   wrapped(m_store->error(), s.callout)));
        if (snapshot)
            banner->addWidget(label(QStringLiteral("Showing data from %1.").arg(Format::relative(snapshot->at, m_store->now())),
                                    s.caption, s.secondary));
        root->addLayout(banner);
    }

    if (tooOld.isEmpty() && !m_store->reconnectHint().isEmpty()) {
        auto *row = new QHBoxLayout;
        row->setSpacing(8);
        row->addWidget(glyph(QStringLiteral("✓"), QStringLiteral("Done"), s.callout, Green), 0, Qt::AlignTop);
        row->addWidget(wrapped(m_store->reconnectHint(), s.callout), 1);
        auto *ok = new QPushButton(QStringLiteral("OK"));
        connect(ok, &QPushButton::clicked, m_store, &Store::dismissReconnectHint);
        row->addWidget(ok, 0, Qt::AlignTop);
        root->addLayout(row);
    }

    if (snapshot && tooOld.isEmpty()) {
        if (const QStringList broken = Format::disconnectedHosts(*snapshot); !broken.isEmpty()) {
            root->addWidget(divider(palette()));
            root->addLayout(connections(broken, m_store, s));
        }
        root->addWidget(divider(palette()));
        root->addLayout(subscriptions(*snapshot, m_store->now(), s));
        root->addWidget(divider(palette()));
        root->addLayout(nextByTier(*snapshot, s));
        root->addWidget(divider(palette()));
        root->addLayout(delegations(*snapshot, m_store->now(), s));
    }
    root->addWidget(divider(palette()));

    auto *footer = new QVBoxLayout;
    footer->setSpacing(6);
    auto *actions = new QHBoxLayout;
    if (tooOld.isEmpty()) {
        auto *edit = new QPushButton(QStringLiteral("Edit Tiers…"));
        edit->setFlat(true);
        connect(edit, &QPushButton::clicked, this, &PopoverWindow::editTiersRequested);
        actions->addWidget(edit);
        actions->addStretch();
    }
    auto *login = new QCheckBox(QStringLiteral("Open at Login"));
    login->setChecked(Desktop::autostartEnabled(Desktop::autostartPath()));
    // The rebuild re-reads the file, so a failed change shows the box as it really is.
    connect(login, &QCheckBox::toggled, this, [this](bool on) {
        m_loginError = Desktop::setAutostart(Desktop::autostartPath(), on, QCoreApplication::applicationFilePath());
        rebuild();
    });
    actions->addWidget(login);
    actions->addStretch();
    auto *quit = new QPushButton(QStringLiteral("Quit"));
    quit->setFlat(true);
    connect(quit, &QPushButton::clicked, qApp, &QCoreApplication::quit);
    actions->addWidget(quit);
    footer->addLayout(actions);
    if (!m_loginError.isEmpty())
        footer->addWidget(wrapped(m_loginError, s.caption, s.secondary));
    root->addLayout(footer);
    return content;
}
