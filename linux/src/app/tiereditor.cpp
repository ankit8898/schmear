#include "tiereditor.h"

#include <QComboBox>
#include <QEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPainter>
#include <QPushButton>
#include <QScrollArea>
#include <QScrollBar>
#include <QSignalBlocker>
#include <QToolButton>
#include <QVBoxLayout>

#include "cli.h"
#include "popover.h"
#include "store.h"
#include "theme.h"

namespace {

class Card : public QWidget {
protected:
    void paintEvent(QPaintEvent *) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setPen(Qt::NoPen);
        QColor fill = palette().color(QPalette::WindowText);
        fill.setAlpha(13);
        p.setBrush(fill);
        p.drawRoundedRect(rect(), 8, 8);
    }
};

QToolButton *actionButton(const QString &glyph, const QString &name)
{
    auto *button = new QToolButton;
    button->setText(glyph);
    button->setAutoRaise(true);
    button->setToolTip(name);
    button->setAccessibleName(name);
    return button;
}

QList<QList<TierEntry>> entries(const TiersDoc &doc)
{
    QList<QList<TierEntry>> tiers;
    for (const QStringList &tier : doc.tiers) {
        QList<TierEntry> entries;
        for (const QString &spec : tier)
            entries.append(TierEntry::fromSpec(spec));
        tiers.append(entries);
    }
    return tiers;
}

}

TierEditor::TierEditor(Store *store, bool scrolls, QWidget *parent) : QDialog(parent), m_store(store)
{
    setWindowTitle(QStringLiteral("schmear Tiers"));
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);
    if (scrolls) {
        setMinimumSize(560, 420);
        resize(600, 560);
        m_scroll = new QScrollArea;
        m_scroll->setFrameShape(QFrame::NoFrame);
        m_scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_scroll->setWidgetResizable(true);
        layout->addWidget(m_scroll);
    }

    m_divider = new QFrame;
    m_divider->setFrameShape(QFrame::HLine);
    m_divider->setFrameShadow(QFrame::Plain);
    layout->addWidget(m_divider);

    auto *footer = new QVBoxLayout;
    footer->setContentsMargins(16, 16, 16, 16);
    footer->setSpacing(8);
    m_status = new QWidget;
    auto *status = new QHBoxLayout(m_status);
    status->setContentsMargins(0, 0, 0, 0);
    status->setSpacing(8);
    m_statusMark = new QLabel;
    m_statusText = new QLabel;
    m_statusText->setWordWrap(true);
    status->addWidget(m_statusMark, 0, Qt::AlignTop);
    status->addWidget(m_statusText, 1);
    footer->addWidget(m_status);
    auto *actions = new QHBoxLayout;
    m_reset = new QPushButton(QStringLiteral("Reset to Defaults"));
    connect(m_reset, &QPushButton::clicked, this, [this] { write({QStringLiteral("tiers"), QStringLiteral("reset")}, {}); });
    actions->addWidget(m_reset);
    actions->addStretch();
    m_working = new QLabel(QStringLiteral("Working…"));
    actions->addWidget(m_working);
    m_save = new QPushButton(QStringLiteral("Save"));
    m_save->setDefault(true);
    connect(m_save, &QPushButton::clicked, this,
            [this] { write({QStringLiteral("tiers"), QStringLiteral("set")}, tiersJson(m_tiers)); });
    actions->addWidget(m_save);
    footer->addLayout(actions);
    layout->addLayout(footer);

    rebuild();
}

void TierEditor::present()
{
    if (isVisible()) {
        raise();
        activateWindow();
        return;
    }
    load();
    show();
}

void TierEditor::setDoc(const TiersDoc &doc)
{
    m_doc = doc;
    m_tiers = entries(doc);
    rebuild();
}

// Secondary colours are computed from the palette when the content is built.
void TierEditor::changeEvent(QEvent *event)
{
    if (event->type() == QEvent::PaletteChange)
        rebuild();
    QDialog::changeEvent(event);
}

void TierEditor::load(std::function<void()> then)
{
    Cli::run({QStringLiteral("tiers")}, {}, this, [this, then](const Reply &reply) {
        QString error = reply.error;
        std::optional<TiersDoc> doc;
        if (reply.status == Reply::Ok)
            doc = decodeTiers(reply.out, &error);
        if (doc) {
            m_error.clear();
            setDoc(*doc);
        } else {
            m_error = error;
            updateFooter();
        }
        if (then)
            then();
    });
}

// The store refresh is not awaited, unlike the Mac: it would hold busy for up to 90 s.
void TierEditor::write(const QStringList &args, const QByteArray &input)
{
    m_busy = true;
    m_message.clear();
    updateFooter();
    Cli::run(args, input, this, [this](const Reply &reply) {
        if (reply.status != Reply::Ok) {
            m_error = reply.error;
            m_busy = false;
            updateFooter();
            return;
        }
        const QString message = QString::fromUtf8(reply.out).trimmed();
        load([this, message] {
            m_message = message;
            m_busy = false;
            updateFooter();
            m_store->refresh();
        });
    });
}

// The old content is deleted later: structural actions start from its own buttons.
void TierEditor::rebuild()
{
    QWidget *content = buildContent();
    if (m_scroll) {
        QScrollBar *bar = m_scroll->verticalScrollBar();
        const int position = bar->value();
        if (QWidget *old = m_scroll->takeWidget())
            old->deleteLater();
        m_scroll->setWidget(content);
        bar->setValue(position);
    } else {
        if (m_content) {
            m_content->hide();
            m_content->deleteLater();
        }
        static_cast<QBoxLayout *>(layout())->insertWidget(0, content);
        m_content = content;
    }
    updateFooter();
}

void TierEditor::updateFooter()
{
    const bool failed = !m_error.isEmpty();
    m_status->setVisible(failed || !m_message.isEmpty());
    m_statusMark->setText(failed ? QStringLiteral("⚠") : QStringLiteral("✓"));
    m_statusMark->setAccessibleName(failed ? QStringLiteral("Warning") : QStringLiteral("Done"));
    setForeground(m_statusMark, failed ? Orange : Green);
    m_statusText->setText(failed ? m_error : m_message);
    m_statusText->setTextInteractionFlags(failed ? Qt::TextSelectableByMouse : Qt::NoTextInteraction);
    setForeground(m_working, secondary(palette()));
    setForeground(m_divider, lineColor(palette()));
    m_working->setVisible(m_busy);
    m_reset->setEnabled(!m_busy);
    m_save->setEnabled(canSave());
}

bool TierEditor::canSave() const
{
    if (!m_doc || m_busy || m_tiers.isEmpty())
        return false;
    for (const auto &tier : m_tiers) {
        if (tier.isEmpty())
            return false;
        for (const auto &entry : tier)
            if (!entry.isComplete())
                return false;
    }
    return true;
}

QWidget *TierEditor::buildContent()
{
    auto *content = new QWidget;
    auto *root = new QVBoxLayout(content);
    root->setContentsMargins(16, 16, 16, 16);
    root->setSpacing(16);
    if (m_doc) {
        auto *source = new QLabel(m_doc->source == QLatin1String("config") ? QStringLiteral("Using your tiers from config")
                                                                            : QStringLiteral("Using the default tiers"));
        setForeground(source, secondary(palette()));
        root->addWidget(source);
    }
    for (int t = 0; t < m_tiers.size(); ++t)
        root->addWidget(tierCard(t));
    if (m_doc) {
        auto *add = new QPushButton(QStringLiteral("+ Add tier"));
        connect(add, &QPushButton::clicked, this, [this] {
            m_tiers.append({TierEntry(m_doc->laneKeys.value(0))});
            rebuild();
        });
        root->addWidget(add, 0, Qt::AlignLeft);
    }
    root->addStretch();
    return content;
}

QWidget *TierEditor::tierCard(int t)
{
    auto *card = new Card;
    auto *box = new QVBoxLayout(card);
    box->setContentsMargins(12, 12, 12, 12);
    box->setSpacing(6);

    auto *header = new QHBoxLayout;
    QString title = QStringLiteral("Tier %1").arg(t + 1);
    if (m_tiers.size() >= 2 && t == 0)
        title += QStringLiteral(" — weakest");
    else if (m_tiers.size() >= 2 && t == m_tiers.size() - 1)
        title += QStringLiteral(" — strongest");
    auto *heading = new QLabel(title);
    QFont headline = font();
    headline.setBold(true);
    heading->setFont(headline);
    header->addWidget(heading);
    header->addStretch();
    QToolButton *up = actionButton(QStringLiteral("↑"), QStringLiteral("Move up"));
    up->setEnabled(t > 0);
    connect(up, &QToolButton::clicked, this, [this, t] {
        m_tiers.swapItemsAt(t, t - 1);
        rebuild();
    });
    QToolButton *down = actionButton(QStringLiteral("↓"), QStringLiteral("Move down"));
    down->setEnabled(t < m_tiers.size() - 1);
    connect(down, &QToolButton::clicked, this, [this, t] {
        m_tiers.swapItemsAt(t, t + 1);
        rebuild();
    });
    QToolButton *remove = actionButton(QStringLiteral("✕"), QStringLiteral("Remove tier"));
    connect(remove, &QToolButton::clicked, this, [this, t] {
        m_tiers.removeAt(t);
        rebuild();
    });
    header->addWidget(up);
    header->addWidget(down);
    header->addWidget(remove);
    box->addLayout(header);

    for (int e = 0; e < m_tiers[t].size(); ++e)
        box->addLayout(entryRow(t, e));

    auto *add = new QPushButton(QStringLiteral("+ Add entry"));
    add->setFlat(true);
    connect(add, &QPushButton::clicked, this, [this, t] {
        m_tiers[t].append(TierEntry(m_doc->laneKeys.value(0)));
        rebuild();
    });
    box->addWidget(add, 0, Qt::AlignLeft);
    return card;
}

QHBoxLayout *TierEditor::entryRow(int t, int e)
{
    const TierEntry &entry = m_tiers[t][e];
    auto *row = new QHBoxLayout;
    row->setSpacing(8);

    auto *lane = new QComboBox;
    lane->setFixedWidth(140);
    QStringList keys = m_doc->laneKeys;
    if (!keys.contains(entry.key))
        keys.prepend(entry.key);
    lane->addItems(keys);
    lane->setCurrentText(entry.key);

    auto *model = new QComboBox;
    model->setEditable(true);
    model->setInsertPolicy(QComboBox::NoInsert);
    model->lineEdit()->setPlaceholderText(QStringLiteral("model"));
    model->addItems(m_doc->offered.value(entry.key));
    model->setEditText(entry.model);

    auto *effort = new QLineEdit(entry.effort);
    effort->setPlaceholderText(QStringLiteral("effort"));
    effort->setFixedWidth(90);

    QToolButton *remove = actionButton(QStringLiteral("−"), QStringLiteral("Remove entry"));

    connect(lane, &QComboBox::currentTextChanged, this, [this, t, e, model](const QString &key) {
        m_tiers[t][e].key = key;
        const QString text = model->currentText();
        const QSignalBlocker blocker(model);
        model->clear();
        model->addItems(m_doc->offered.value(key));
        model->setEditText(text);
        updateFooter();
    });
    connect(model, &QComboBox::editTextChanged, this, [this, t, e](const QString &text) {
        m_tiers[t][e].model = text;
        updateFooter();
    });
    connect(effort, &QLineEdit::textChanged, this, [this, t, e](const QString &text) {
        m_tiers[t][e].effort = text;
        updateFooter();
    });
    connect(remove, &QToolButton::clicked, this, [this, t, e] {
        m_tiers[t].removeAt(e);
        rebuild();
    });

    row->addWidget(lane);
    row->addWidget(model, 1);
    row->addWidget(effort);
    row->addWidget(remove);
    return row;
}
