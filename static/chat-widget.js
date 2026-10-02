/* ==========================================================================
 * ChatWidget — an embeddable website chat assistant.
 *
 * Drop it into ANY website with 3 lines:
 *
 *   <link rel="stylesheet" href="https://your-server/widget/chat-widget.css">
 *   <script src="https://your-server/widget/chat-widget.js"></script>
 *   <script>ChatWidget.init({ apiUrl: "https://your-server/api/chat" });</script>
 *
 * Options for ChatWidget.init():
 *   apiUrl       (required)  URL of the POST /api/chat endpoint
 *   businessName (optional)  shown in the panel header  (default: "Assistant")
 *   accentColor  (optional)  bubble/header color        (default: "#22301e")
 *   greeting     (optional)  first bot message          (default: built-in)
 *   quickReplies (optional)  initial chips              (default: built-in)
 *
 * The fetch contract is fixed: POST {message, context} -> {reply,
 * quick_replies, context}. Swap the backend for an LLM later; this file
 * never changes.
 * ========================================================================== */
(function (global) {
  "use strict";

  var DEFAULTS = {
    apiUrl: "",
    businessName: "Assistant",
    accentColor: "#22301e",
    greeting:
      "Hello! I'm the Saffron & Sage assistant. Ask me about our hours, menu, reservations, or dietary options.",
    quickReplies: ["What are your hours?", "Show me the menu", "Book a table"],
  };

  var EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // shared with page motion

  /* Custom inline SVG icons — never emoji. */
  var ICONS = {
    /* Chat bubble with a spark */
    bubble:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
      '<path d="M12 7.6l1.05 2.25 2.25 1.05-2.25 1.05L12 14.2l-1.05-2.25L8.7 10.9l2.25-1.05z" fill="currentColor" stroke="none"/>' +
      "</svg>",
    close:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M2.5 2.5l11 11M13.5 2.5l-11 11"/>' +
      "</svg>",
    send:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M22 2L11 13"/>' +
      '<path d="M22 2l-7 20-4-9-9-4z"/>' +
      "</svg>",
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function ChatWidget(opts) {
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.context = {};
    this.isOpen = false;
    this.built = false;
    this._nudgeTimer = null;
  }

  ChatWidget.prototype.init = function () {
    if (this.built || !this.opts.apiUrl) return;
    this.built = true;
    var self = this;
    var o = this.opts;

    document.documentElement.style.setProperty("--cw-accent", o.accentColor);

    /* --- floating launcher ------------------------------------------------ */
    var launcher = el("button", "cw-launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open chat with " + o.businessName);
    launcher.setAttribute("aria-expanded", "false");
    launcher.innerHTML = ICONS.bubble;
    var badge = el("span", "cw-badge");
    badge.setAttribute("aria-hidden", "true");
    launcher.appendChild(badge);
    launcher.addEventListener("click", function () { self.toggle(); });

    /* --- chat panel -------------------------------------------------------- */
    var panel = el("div", "cw-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with " + o.businessName);
    panel.setAttribute("aria-hidden", "true");

    var header = el("div", "cw-header");
    var avatar = el("div", "cw-avatar");
    avatar.innerHTML = ICONS.bubble;
    avatar.setAttribute("aria-hidden", "true");
    avatar.appendChild(el("span", "cw-online"));
    header.appendChild(avatar);
    var title = el("div", "cw-title");
    title.appendChild(el("strong", null, o.businessName));
    title.appendChild(el("span", "cw-status", "Online — replies instantly"));
    header.appendChild(title);
    var closeBtn = el("button", "cw-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.innerHTML = ICONS.close;
    closeBtn.addEventListener("click", function () { self.close(); });
    header.appendChild(closeBtn);

    var messages = el("div", "cw-messages");
    messages.setAttribute("aria-live", "polite");
    messages.setAttribute("aria-label", "Conversation");
    var quickBar = el("div", "cw-quick");
    var form = el("form", "cw-form");
    var input = el("input", "cw-input");
    input.type = "text";
    input.placeholder = "Type your message…";
    input.setAttribute("aria-label", "Type your message");
    input.autocomplete = "off";
    input.maxLength = 500;
    var sendBtn = el("button", "cw-send");
    sendBtn.type = "submit";
    sendBtn.setAttribute("aria-label", "Send message");
    sendBtn.innerHTML = ICONS.send;
    form.appendChild(input);
    form.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(quickBar);
    panel.appendChild(form);

    var root = el("div", "cw-root");
    root.appendChild(panel);
    root.appendChild(launcher);
    document.body.appendChild(root);

    this.nodes = { root: root, launcher: launcher, badge: badge, panel: panel,
                   messages: messages, quickBar: quickBar, form: form, input: input };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      self.send(text);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && self.isOpen) self.close();
    });

    /* Greeting + chips on first build (visible when the panel opens). */
    this.addMessage("bot", o.greeting);
    this.renderQuickReplies(o.quickReplies);

    /* Unread-badge nudge: if the visitor hasn't opened the chat after a
       moment, show the dot to invite them in. Cleared on first open. */
    this._nudgeTimer = setTimeout(function () {
      if (!self.isOpen) badge.classList.add("cw-show");
    }, 2200);
  };

  ChatWidget.prototype.toggle = function () {
    if (this.isOpen) this.close();
    else this.open();
  };

  ChatWidget.prototype.open = function () {
    if (this.isOpen || !this.built) return;
    this.isOpen = true;
    var n = this.nodes;
    n.root.classList.add("cw-open");
    n.launcher.setAttribute("aria-expanded", "true");
    n.panel.setAttribute("aria-hidden", "false");
    n.badge.classList.remove("cw-show");
    if (this._nudgeTimer) { clearTimeout(this._nudgeTimer); this._nudgeTimer = null; }
    this.scrollToBottom();
    /* Focus the input once the panel has eased open. */
    setTimeout(function () { n.input.focus({ preventScroll: true }); }, 380);
  };

  ChatWidget.prototype.close = function () {
    if (!this.isOpen || !this.built) return;
    this.isOpen = false;
    var n = this.nodes;
    n.root.classList.remove("cw-open");
    n.launcher.setAttribute("aria-expanded", "false");
    n.panel.setAttribute("aria-hidden", "true");
    n.launcher.focus({ preventScroll: true });
  };

  ChatWidget.prototype.scrollToBottom = function () {
    var m = this.nodes.messages;
    requestAnimationFrame(function () { m.scrollTop = m.scrollHeight; });
  };

  ChatWidget.prototype.addMessage = function (who, text) {
    var n = this.nodes;
    var row = el("div", "cw-row cw-" + who);
    var bubble = el("div", "cw-msg");
    text.split("\n").forEach(function (line, i, arr) {
      bubble.appendChild(document.createTextNode(line));
      if (i < arr.length - 1) bubble.appendChild(el("br"));
    });
    row.appendChild(bubble);
    row.appendChild(el("div", "cw-time", stamp()));
    n.messages.appendChild(row);
    this.scrollToBottom();
    return row;
  };

  ChatWidget.prototype.showTyping = function () {
    var row = el("div", "cw-row cw-bot");
    row.innerHTML = '<div class="cw-msg cw-typing" aria-hidden="true"><span></span><span></span><span></span></div>';
    row.setAttribute("aria-label", "Assistant is typing");
    this.nodes.messages.appendChild(row);
    this.scrollToBottom();
    return row;
  };

  ChatWidget.prototype.renderQuickReplies = function (replies) {
    var n = this.nodes, self = this;
    n.quickBar.innerHTML = "";
    (replies || []).forEach(function (label, i) {
      var b = el("button", "cw-chip", label);
      b.type = "button";
      b.style.animationDelay = Math.min(i * 70, 280) + "ms";
      b.addEventListener("click", function () { self.send(label); });
      n.quickBar.appendChild(b);
    });
  };

  ChatWidget.prototype.send = function (text) {
    var self = this;
    if (!this.isOpen) this.open();
    this.addMessage("user", text);
    this.renderQuickReplies([]);
    var typingRow = this.showTyping();

    fetch(this.opts.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, context: this.context }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("bad response");
        return res.json();
      })
      .then(function (data) {
        typingRow.remove();
        self.context = data.context || self.context;
        self.addMessage("bot", data.reply || "Sorry — something went wrong on my end.");
        self.renderQuickReplies(data.quick_replies);
      })
      .catch(function () {
        typingRow.remove();
        self.addMessage(
          "bot",
          "Hmm, I'm having trouble reaching the server. Please try again in a moment — " +
          "or call us at (312) 555-0194 and a human will help right away."
        );
        self.renderQuickReplies(self.opts.quickReplies);
      });
  };

  /* Public API */
  global.ChatWidget = {
    init: function (opts) {
      var w = new ChatWidget(opts);
      w.init();
      return w;
    },
    _ease: EASE,
  };
})(window);
