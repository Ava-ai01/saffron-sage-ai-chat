"""
Saffron & Sage — restaurant website chat assistant (demo backend).

A small Flask app that powers the embeddable chat widget. The /api/chat
endpoint uses keyword/intent matching against a knowledge base, remembers
simple conversation context (the visitor's name), and always fails gracefully.

The endpoint contract is deliberately LLM-shaped — POST JSON in, JSON with a
"reply" out — so it can be swapped for a real LLM API (OpenAI, Anthropic,
etc.) later without touching the widget front end.

Routes:
  GET  /demo                    the Saffron & Sage demo landing page (widget embedded)
  GET  /                        alias for /demo
  GET  /widget/chat-widget.js   the embeddable widget script
  GET  /widget/chat-widget.css  the embeddable widget stylesheet
  POST /api/chat                {"message": "...", "context": {...}} -> {"reply", "quick_replies", "context"}
  GET  /api/health              liveness check
"""
import re

from flask import Flask, jsonify, request, render_template
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # the widget is designed to be embedded on ANY website

# ---------------------------------------------------------------------------
# Knowledge base — everything the assistant knows about the restaurant.
# A real client engagement would fill this from their menu, hours, etc.
# ---------------------------------------------------------------------------
RESTAURANT = {
    "name": "Saffron & Sage",
    "tagline": "Modern Mediterranean Kitchen",
    "address": "2148 N Halsted St, Chicago, IL 60614",
    "phone": "(312) 555-0194",
    "hours": {
        "tue_thu": "11:30 AM – 10:00 PM",
        "fri_sat": "11:30 AM – 11:00 PM",
        "sun": "12:00 PM – 9:00 PM",
        "mon": "Closed",
    },
    "reservation_policy": (
        "You can book online for parties of 1–5 using the Reserve button on our "
        "website. For parties of 6 or more, or same-day requests, please call us "
        "at (312) 555-0194 and we'll set you up."
    ),
    "menu_highlights": [
        ("Charred Octopus", "$24", "grilled octopus, smoked paprika, lemon aioli"),
        ("Saffron Chicken Tagine", "$28", "slow-cooked chicken, apricots, almonds, couscous"),
        ("Wild Mushroom Mezze Board", "$18", "hummus, whipped feta, olives, warm pita"),
        ("Harissa Salmon", "$32", "crispy skin salmon, harissa glaze, herb salad"),
        ("Pistachio Baklava", "$12", "honey, orange blossom, vanilla gelato"),
    ],
    "dietary": (
        "We take dietary needs seriously: about half our menu is vegetarian, "
        "we always have at least three vegan dishes (the mezze board and lentil "
        "tagine are guest favorites), and most dishes can be made gluten-free — "
        "just ask your server. Please mention allergies when you book so the "
        "kitchen is ready."
    ),
    "takeout": (
        "Yes! Order takeout through the Order Online button on our website, or "
        "call (312) 555-0194. Pickup is usually ready in 20–25 minutes. We "
        "deliver within 3 miles through our own drivers on Fri–Sun evenings."
    ),
    "parking": (
        "Street parking is available on Halsted and the side streets (metered "
        "until 9 PM). There's also a public garage one block south at "
        "2150 N Lincoln Ave."
    ),
}

HOURS_LINE = (
    f"We're open Tue–Thu {RESTAURANT['hours']['tue_thu']}, "
    f"Fri–Sat {RESTAURANT['hours']['fri_sat']}, "
    f"Sun {RESTAURANT['hours']['sun']}, and closed on Mondays."
)

DEFAULT_QUICK_REPLIES = [
    "What are your hours?",
    "Show me the menu",
    "Book a table",
]

# ---------------------------------------------------------------------------
# Intent matching — ordered list of (intent_name, [keywords]).
# First intent whose keywords appear in the message wins.
# ---------------------------------------------------------------------------
INTENTS = [
    ("hours",       ["hour", "open", "close", "when are", "what time", "schedule"]),
    ("location",    ["where", "address", "location", "direction", "parking", "park", "find you", "get there"]),
    ("reservation", ["reserv", "book", "table", "seat", "party of", "group of"]),
    ("menu",        ["menu", "eat", "food", "dish", "serve", "special", "recommend"]),
    ("dietary",     ["vegan", "vegetarian", "gluten", "allergy", "allerg", "dietary", "halal", "kosher", "dairy"]),
    ("price",       ["price", "cost", "expensive", "how much", "cheap", "$"]),
    ("takeout",     ["takeout", "take out", "take-away", "pickup", "pick up", "deliver", "to go", "order online"]),
    ("contact",     ["phone", "number", "call", "contact", "email", "reach"]),
    ("thanks",      ["thank", "thanks", "great", "perfect", "awesome"]),
    ("bye",         ["bye", "goodbye", "see you", "later"]),
    ("greeting",    ["hello", "hi", "hey", "good morning", "good afternoon", "good evening"]),
]

NAME_PATTERNS = [
    re.compile(r"\bmy name is ([a-zA-Z'-]{2,20})", re.I),
    re.compile(r"\bi'm ([a-zA-Z'-]{2,20})", re.I),
    re.compile(r"\bcall me ([a-zA-Z'-]{2,20})", re.I),
    re.compile(r"\bthis is ([a-zA-Z'-]{2,20})", re.I),
]

SMALLTALK = re.compile(r"\b(how are you|how's it going|what's up)\b", re.I)


def detect_name(message):
    for pat in NAME_PATTERNS:
        m = pat.search(message)
        if m:
            name = m.group(1).strip().capitalize()
            if name.lower() not in {"just", "here", "the", "a", "an", "looking"}:
                return name
    return None


def match_intent(message):
    msg = message.lower()
    for intent, keywords in INTENTS:
        if any(k in msg for k in keywords):
            return intent
    return None


def menu_text():
    lines = ["Here's a taste of our menu:"]
    for name, price, desc in RESTAURANT["menu_highlights"]:
        lines.append(f"• {name} — {price} ({desc})")
    lines.append("Full menu with today's specials is on our website under Menu.")
    return "\n".join(lines)


def build_reply(intent, name):
    """Return the reply text for an intent. `name` may be None."""
    who = f" {name}" if name else ""
    if intent == "hours":
        return HOURS_LINE + f" Hope to see you soon{who}!"
    if intent == "location":
        return (f"You'll find us at {RESTAURANT['address']}. "
                f"{RESTAURANT['parking']}")
    if intent == "reservation":
        return RESTAURANT["reservation_policy"]
    if intent == "menu":
        return menu_text()
    if intent == "dietary":
        return RESTAURANT["dietary"]
    if intent == "price":
        return ("Most mains are $18–$32, starters $12–$18, and desserts around "
                "$12. It's a relaxed night out, not a splurge — most guests "
                "spend about $45–$60 per person with a drink.")
    if intent == "takeout":
        return RESTAURANT["takeout"]
    if intent == "contact":
        return f"You can reach us at {RESTAURANT['phone']} — we pick up during open hours."
    if intent == "thanks":
        return f"You're very welcome{who}! Anything else I can help with?"
    if intent == "bye":
        return f"Goodbye{who}! Thanks for stopping by — see you soon."
    if intent == "greeting":
        return (f"Hello{who}! I'm the {RESTAURANT['name']} assistant. "
                "Ask me about our hours, menu, reservations, or dietary options.")
    # Graceful fallback — never a dead end
    return (
        f"I'm not sure about that one{who}, but I'd love to help with what I "
        f"know best: our hours, location, menu, reservations, or dietary "
        f"options. Or call us at {RESTAURANT['phone']} and a human will "
        f"sort you out right away."
    )


@app.post("/api/chat")
def chat():
    """
    Request:  {"message": "...", "context": {"user_name": "..."} }
    Response: {"reply": "...", "quick_replies": [...], "context": {...}}

    Swap this body for an LLM call later; the contract stays the same.
    """
    data = request.get_json(force=True, silent=True) or {}
    message = (data.get("message") or "").strip()
    context = dict(data.get("context") or {})

    if not message:
        return jsonify({
            "reply": "Go ahead — ask me anything about the restaurant!",
            "quick_replies": DEFAULT_QUICK_REPLIES,
            "context": context,
        })

    # 1) Remember the visitor's name when they introduce themselves
    detected = detect_name(message)
    if detected:
        context["user_name"] = detected
        return jsonify({
            "reply": (f"Lovely to meet you, {detected}! I'm the "
                      f"{RESTAURANT['name']} assistant. What can I do for you?"),
            "quick_replies": DEFAULT_QUICK_REPLIES,
            "context": context,
        })

    # 2) Small talk gets a friendly, on-brand answer
    if SMALLTALK.search(message):
        name = context.get("user_name")
        who = f" {name}" if name else ""
        return jsonify({
            "reply": (f"I'm doing great{who}, thanks for asking! The kitchen "
                      f"smells amazing today. How can I help you?"),
            "quick_replies": DEFAULT_QUICK_REPLIES,
            "context": context,
        })

    # 3) Intent-based answer, else graceful fallback
    intent = match_intent(message)
    reply = build_reply(intent, context.get("user_name"))
    return jsonify({
        "reply": reply,
        "quick_replies": [] if intent == "bye" else DEFAULT_QUICK_REPLIES,
        "context": context,
    })


@app.get("/api/health")
@app.get("/health")
def health():
    return jsonify({"ok": True, "restaurant": RESTAURANT["name"]})


# ---------------------------------------------------------------------------
# Demo page — the Saffron & Sage landing page, with the widget embedded.
# ---------------------------------------------------------------------------
@app.get("/demo")
def demo():
    return render_template("demo.html")


@app.get("/")
def index():
    return render_template("demo.html")


@app.get("/widget/chat-widget.js")
@app.get("/widget.js")
def widget_js():
    return app.send_static_file("chat-widget.js")


@app.get("/widget/chat-widget.css")
@app.get("/widget.css")
def widget_css():
    return app.send_static_file("chat-widget.css")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5057, debug=False)
