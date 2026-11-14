"""Vesper, the Live TV host. She introduces what's coming up between shows and greets people who tune in late.

Her mood follows the viewer's clock: friendly and family-safe in the day, sly in the evening, and properly evil during
Horror Hours (10pm-4am). Art: web/host/<mood>.png and <mood>-talk.png (5 frames, 128px). Lines are picked with a seed
made from the programme, so everyone watching the same channel hears the same thing.
"""
import random

NAME = "Vesper"


def mood(hour):
    if hour is None:
        return "dusk"
    if 6 <= hour < 17:
        return "day"
    if 17 <= hour < 22 or 4 <= hour < 6:
        return "dusk"
    return "evil"


GREET = {
    "day": ["Hello, friends! Pick a channel, any channel.", "Good day! The couch is warm and the channels are on.",
            "Welcome back! Everything's playing, and nothing bites. Yet."],
    "dusk": ["Good evening. The sun's going down, and the good stuff is coming up.", "Ah, you're here. Find a seat. Not that one.",
             "Evening, darling. The channels have been waiting for you."],
    "evil": ["You're still awake. How… delicious.", "Welcome to the late shift. The doors lock themselves now.",
             "Nobody else is up. Just you. And me. And everything on these channels."],
}

INTRO = {  # between shows: {t} the next title, {ch} the channel
    "day": ["Coming right up on {ch}: {t}! Grab a snack and a blanket.", "Next up, {t}. I hear it's a good one!",
            "Stay right there, {t} is about to start.", "Get comfy, {t} is next on {ch}."],
    "dusk": ["The lights are dimming… {t} is next. Don't go anywhere.", "Next on {ch}: {t}. I'll leave a light on for you. Maybe.",
             "Ooh, {t}. Excellent choice. Well, my choice.", "Stay a while. {t} is just about to begin."],
    "evil": ["{t} is next. Lock the door. Then check it again.", "You're still here? Good. {t} starts in a moment… and so do I.",
             "Don't look behind you. Look at the screen. {t} is coming.", "Next: {t}. If you hear something in the kitchen, it's probably nothing."],
}

JOIN = {  # tuned in part-way: {t} the title, {m} minutes in
    "day": ["You made it! We're {m} minutes into {t}.", "Just in time! {t} is on, and the best part's still coming.",
            "Welcome aboard, it's {t} on {ch}!"],
    "dusk": ["Ah, a latecomer. {t} started without you… it does that.", "{m} minutes into {t}. You haven't missed the worst part.",
             "Shh. {t} is on. Sit down, quietly."],
    "evil": ["Sit down. {t} has been waiting for you.", "{m} minutes into {t}. Something already got the first one.",
             "Late again. {t} doesn't forgive. Neither do I."],
}

TAKEOVER = {  # said first on a takeover channel: (day, dusk, evil)
    "halloween": ("Happy Halloween! Costumes on, candy out, scary movies all day!",
                  "It's Halloween night. Every channel's a little haunted, but this one's possessed.",
                  "Halloween. The one night they let me out. Let's not waste it."),
    "krampus": ("Happy Krampusnacht! Be good today, okay?",
                "Krampusnacht. Somebody's checking the naughty list. Twice.",
                "Krampusnacht. Hear the chains? He's in the building."),
    "xmaseve": ("Merry Christmas Eve! Cocoa, blankets, and a few frights.",
                "Christmas Eve. Silent night? Not on this channel.",
                "Christmas Eve, and all through the house… something is stirring."),
    "valentine": ("Happy Valentine's Day! Love is in the air. Mostly.",
                  "Valentine's Day. Hearts, flowers, and a few that got broken. Literally.",
                  "Be my Valentine. You don't really have a choice."),
    "friday13": ("Friday the 13th! Knock on wood and stay out of the lake.",
                 "Friday the 13th. Stay out of the woods. And the cabin. And the lake.",
                 "Friday the 13th. He's back. He's always back."),
    "fullmoon": ("Full moon tonight! The wolves are out, but they're friendly. Probably.",
                 "Full moon tonight. If you hear howling, that's just the TV. Hopefully.",
                 "Full moon. Check your hands. Hairy yet?"),
}


def _pick(options, seed):
    return random.Random(seed).choice(options)


def _title(p):
    return p.get("show") or p.get("title") or "this one"


def greeting(hour, takeover=None):
    m = mood(hour)
    if takeover in TAKEOVER:
        return {"name": NAME, "mood": m, "line": TAKEOVER[takeover][("day", "dusk", "evil").index(m)]}
    return {"name": NAME, "mood": m, "line": _pick(GREET[m], f"greet:{hour}")}


def line(program, channel_name, hour, offset, takeover=None):
    """What Vesper says when you tune in: an intro if the programme hasn't started (offset < 0), else a welcome."""
    m = mood(hour)
    seed = f"{program['id']}:{int(program['start'])}"
    if takeover in TAKEOVER and offset < 0 and random.Random(seed).random() < 0.5:
        text = TAKEOVER[takeover][("day", "dusk", "evil").index(m)]
    elif offset < 0:
        text = _pick(INTRO[m], seed).format(t=_title(program), ch=channel_name)
    else:
        text = _pick(JOIN[m], seed + ":join").format(t=_title(program), ch=channel_name, m=max(1, int(offset // 60)))
    return {"name": NAME, "mood": m, "line": text}
