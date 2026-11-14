"""Vesper, the Live TV host. She introduces what's coming up between shows and greets people who tune in late.

Her mood follows the viewer's clock: friendly and family-safe in the day, sly in the evening, and properly evil during
Horror Hours (10pm-4am). Art: web/host/<mood>.png and <mood>-talk.png (5 frames, 128px).

She has a lot to say (general lines, lines for each channel, the witching hour, weekends, takeover days) and remembers
what she's said to each person lately, so she doesn't repeat herself.
"""
import collections, random, threading

NAME = "Vesper"
MOODS = ("day", "dusk", "evil")


def mood(hour):
    if hour is None:
        return "dusk"
    if 6 <= hour < 17:
        return "day"
    if 17 <= hour < 22 or 4 <= hour < 6:
        return "dusk"
    return "evil"


GREET = {
    "day": [
        "Hello, friends! Pick a channel, any channel.", "Good day! The couch is warm and the channels are on.",
        "Welcome back! Everything's playing, and nothing bites. Yet.", "Rise and shine! Well, mostly shine. I'm more of a night person.",
        "Oh good, company! I was starting to talk to the test pattern.", "Snacks? Check. Blanket? Check. Remote? You've got it. Let's go.",
        "Every channel's live. Pick one and I'll pretend I picked it for you.", "A whole day of TV and no commercials. Aren't you lucky?",
        "Hi there! I dusted the channels just for you.", "Welcome to the daytime lineup. Bright, cheery, and only slightly haunted.",
        "There you are! The good seat's still free.", "Nothing to do? Perfect. That's exactly what TV is for.",
        "Hello, sunshine! Don't mind me, I'm just the host. And the ghoul.", "Fresh popcorn, fresh channels. Dig in.",
        "Stay as long as you like. I certainly will.", "Ooh, a daytime viewer. Very civilised.",
        "I've put the kettle on. It's been on since 1987, but still.", "Pull up a chair! All the channels are warmed up.",
        "Good to see you! I promise I'm friendlier than I look.", "Welcome! Today's forecast: cloudy with a chance of marathons.",
        "Channel surfing? Mind the waves.", "It's a lovely day to stay inside and watch something.",
    ],
    "dusk": [
        "Good evening. The sun's going down, and the good stuff is coming up.", "Ah, you're here. Find a seat. Not that one.",
        "Evening, darling. The channels have been waiting for you.", "The streetlights are on. That means it's my time.",
        "Dim the lights. All of them. Yes, that one too.", "Welcome to the evening lineup. I picked it myself. With my teeth.",
        "Dinner's done, the dishes can wait. Pick a channel.", "Evening. I've been saving the good ones for after dark.",
        "The shadows are getting longer. So is my list of recommendations.", "Oh, you're back. I knew you would be. They always come back.",
        "Settle in. It's going to be a long, lovely night.", "Twilight, my favourite. Neither here nor there. Like me.",
        "Good evening. Please keep your hands and feet inside the couch.", "The sun's gone. Don't worry, I'll keep you company.",
        "Ah, the evening crowd. Much more my type.", "Lock the windows, warm the popcorn. Showtime.",
        "I hear the neighbours went to bed early. More TV for us.", "Evening, friend. Something's always on. Something's always watching.",
        "You look like someone who needs a double feature.", "Curtains closed? Good. Now we can begin.",
        "The night is young. I, however, am not.", "Grab a blanket. It's getting chilly. Or that's just me.",
    ],
    "evil": [
        "You're still awake. How… delicious.", "Welcome to the late shift. The doors lock themselves now.",
        "Nobody else is up. Just you. And me. And everything on these channels.", "Horror Hours. The good kind of trouble.",
        "Don't mind the scratching at the window. It's a fan.", "It's late. Your bed misses you. I don't care.",
        "Shh. Everyone's asleep. Let's keep it that way.", "The candle's low and the channels are hungry.",
        "You came back after dark. Bold choice.", "Midnight snack? I'll have whatever you're having. Or whoever.",
        "The house makes noises at night. Most of them are fine.", "Welcome, night owl. Sit. Stay. Good.",
        "I see you. Well, I see your remote. Same thing.", "Lights off. Phone down. Eyes on me. I mean the screen.",
        "It's the hour when the static starts whispering.", "Can't sleep? Don't worry. Neither can I. Ever.",
        "One more episode, you said. Three episodes ago.", "Welcome to the part of the night nobody talks about.",
        "Everything's better after midnight. Especially the screaming.", "Ah, a fellow creature of the night.",
        "The channels get stranger after dark. So do I.", "Pull the blanket up. Higher. That's better.",
    ],
}

WITCHING = [  # 1am-4am, mixed in with the evil lines
    "It's the witching hour. Don't say my name three times. Actually, go ahead.",
    "Three in the morning. Nothing good happens now. Except television.",
    "At this hour, the only ones awake are you, me, and the thing under the stairs.",
    "You should be asleep. But then who would I talk to?",
    "The dead of night. Emphasis on dead.",
    "Even the ghosts went to bed. Not you, though.",
]

WEEKEND = [  # Friday evening to Sunday, mixed in with the greetings
    "It's the weekend! No alarm, no rules, no mercy.", "Weekend marathon? I'll get the snacks. You get the remote.",
    "No work tomorrow. Let's make some bad decisions. With TV.", "The weekend's here. Time to stay in on purpose.",
]

INTRO = {  # between shows: {t} the next title, {ch} the channel
    "day": [
        "Coming right up on {ch}: {t}! Grab a snack and a blanket.", "Next up, {t}. I hear it's a good one!",
        "Stay right there, {t} is about to start.", "Get comfy, {t} is next on {ch}.",
        "Ooh, {t} is next. Perfect timing!", "Quick bathroom break? You've got a minute before {t}.",
        "Next on {ch}: {t}. Don't touch that dial!", "Here it comes: {t}. I've been looking forward to this one.",
        "Refill your drink, {t} is just around the corner.", "You picked the right channel. {t} is up next.",
        "{t}, coming up! Feet up, phone down.", "Almost time for {t}. I'll save your seat.",
        "Stretch your legs. {t} starts in a moment.", "This is {ch}, and {t} is next. Lucky you.",
        "{t} is coming up next! It's a good one, I checked.", "Just a moment and {t} begins. Ready?", "Next on {ch}, it's {t}! Woohoo!", "{t} next. Time to find the remote you're holding.", "Coming up: {t}. Get the good snacks out.", "In a minute: {t}. Don't you dare change the channel.", "{t} is up next. I'll be quiet. Mostly.", "Ready, set… {t}! Almost.", "Next: {t}. Somebody dim the sun a little.", "Up next on {ch}: {t}. Pure joy, I promise.",
    ],
    "dusk": [
        "The lights are dimming… {t} is next. Don't go anywhere.", "Next on {ch}: {t}. I'll leave a light on for you. Maybe.",
        "Ooh, {t}. Excellent choice. Well, my choice.", "Stay a while. {t} is just about to begin.",
        "{t} is coming up. Pull the curtains.", "In a moment: {t}. I've seen it. I won't spoil it. Much.",
        "Next up on {ch}: {t}. Get the good blanket.", "You're just in time for {t}. Funny how that works.",
        "{t} is next. Turn the lights down. Lower. There.", "Don't wander off. {t} is starting, and I hate watching alone.",
        "Coming up after the shadows: {t}.", "{t} next. I'll be right here. I'm always right here.",
        "And now, for your evening pleasure: {t}.", "Hush now. {t} is about to begin on {ch}.",
        "Next on {ch}… {t}. Stay. Stay.", "{t} is about to begin. The moon is up. So am I.", "Coming up: {t}. Not that you had other plans.", "In a moment, {t}. Somebody check the back door.", "{t} next. The evening only gets better. Or worse.", "Get comfortable. {t} is almost here.", "Up next: {t}. Bring the blanket closer.", "{t} is coming. I can feel it.", "Next on {ch}: {t}. Lovely choice. Mine, again.", "A moment of darkness, and then {t}.",
    ],
    "evil": [
        "{t} is next. Lock the door. Then check it again.", "You're still here? Good. {t} starts in a moment… and so do I.",
        "Don't look behind you. Look at the screen. {t} is coming.", "Next: {t}. If you hear something in the kitchen, it's probably nothing.",
        "{t} is up next. Nobody leaves until the credits.", "In a moment: {t}. Keep your feet off the floor.",
        "{t}, coming right up. I hope you're not alone. Actually, I hope you are.", "Next on {ch}: {t}. Sweet dreams. Later.",
        "The candle flickers… {t} is about to begin.", "{t} is next. Whatever happens, don't pause it.",
        "Stay very still. {t} is starting.", "Coming up: {t}. Don't answer the door if anyone knocks.",
        "{t} next on {ch}. I picked it while you were sleeping. Oh wait.", "Get closer to the screen. Closer. {t} is next.",
        "{t} is next. Turn off the hallway light. Actually, leave it on.", "Coming up: {t}. You won't sleep. You weren't going to anyway.", "In a moment: {t}. Count your exits.", "{t} next on {ch}. Don't look in the mirror until it's over.", "Next: {t}. Someone's breathing. Hopefully you.", "{t} is about to start. The house just got quieter.", "Up next, {t}. I wouldn't go to the kitchen right now.", "{t} next. I hope you said goodnight to everyone. Just in case.", "The static settles… and here comes {t}.", "{t} is coming for you. Next. On {ch}.",
    ],
}

JOIN = {  # tuned in part-way: {t} the title, {m} minutes in, {ch} the channel
    "day": [
        "You made it! We're {m} minutes into {t}.", "Just in time! {t} is on, and the best part's still coming.",
        "Welcome aboard, it's {t} on {ch}!", "Hi! You're watching {t}. Catch up, I'll wait.",
        "Jump right in! {t} has only been on {m} minutes.", "Oh, you're here for {t}? Good taste.",
        "{t}, {m} minutes in. Don't worry, it's easy to follow.", "Hello! {t} is on. I'll fill you in later.",
        "Perfect timing. {t} is just getting good.", "You found {ch}! It's {t} right now.",
        "Sit down, sit down. {t} is on and it's a fun one.", "{m} minutes into {t}. You didn't miss much. Promise.",
        "Hey, you! {t} is on {ch}. Make yourself at home.", "{t} is rolling. Grab a cushion, the good one.", "Ah, perfect. We're {m} minutes into {t}, and it's just warming up.", "Welcome! I saved you a spot for {t}.", "You tuned in at just the right moment. Well, a moment. {t}.", "{t} on {ch}. The snacks are on you.", "Glad you're here! {t} is better with company.", "{m} minutes of {t} down. Plenty more to go.", "Look who found {ch}! It's {t}.", "Oh, lovely. A visitor. We're watching {t}.", "Feet up! {t} is on and nobody needs anything from you.", "You're just in time for the middle of {t}. Best part!",
    ],
    "dusk": [
        "Ah, a latecomer. {t} started without you… it does that.", "{m} minutes into {t}. You haven't missed the worst part.",
        "Shh. {t} is on. Sit down, quietly.", "Evening. You're {m} minutes into {t}. Keep up.",
        "{t} is on {ch}. Grab a seat in the dark.", "Oh, there you are. {t} has been going {m} minutes.",
        "Welcome in. {t} is playing. Mind the shadows.", "You've wandered into {t}. There's no wandering out.",
        "{t}. {m} minutes in. Just in time for the twist. Or not.", "Look who's here. {t} is on, and so am I.",
        "Late, but stylish. It's {t} on {ch}.", "Join us. We're watching {t}. We're always watching.",
        "{t} is on. Pull the blinds.", "Ah, you've found us. {t}, {m} minutes in.", "Pull up a shadow. {t} is on {ch}.", "The evening feature: {t}. You're a little late. I forgive you. This time.", "{t} is playing. I've been keeping it warm for you.", "Hush, hush. {t}. Sit.", "{m} minutes into {t}. Things are about to get interesting.", "Welcome to the evening show. Tonight: {t}.", "You came for {t}? Everyone does, eventually.", "Find a seat. {t} is on, and the lights are going down.", "There's room on the couch. There's always room. {t} is on.", "Oh, you're just in time to be too late. It's {t}.",
    ],
    "evil": [
        "Sit down. {t} has been waiting for you.", "{m} minutes into {t}. Something already got the first one.",
        "Late again. {t} doesn't forgive. Neither do I.", "You're watching {t}. And something's watching you.",
        "{t}, {m} minutes in. Don't ask what you missed. You don't want to know.", "Welcome to {ch}. It's {t}. There's no leaving now.",
        "Quiet. {t} is on. They can hear you breathing.", "{m} minutes into {t}. The screaming starts soon. Probably yours.",
        "Ah. Fresh company. {t} is on.", "{t} is playing. Lock the door behind you.",
        "You found {ch} at this hour? Brave. It's {t}.", "{t}, {m} minutes in. Don't turn around.",
        "Close the door. {t} is on. Don't let anything in.", "{t}. Don't blink. It's been {m} minutes and I haven't.", "You found {t} in the dark. Or it found you.", "Welcome back to {ch}. {t} is on. The candle is low.", "{m} minutes into {t}. Keep your hands where I can see them.", "Shh. Something in {t} is listening. So am I.", "You're late for {t}. The others didn't make it either.", "{t} is on. The floorboards are creaking. That's fine.", "It's {t}, and it's far too late to be watching it. Perfect.", "Sit down before it notices you. {t} is on.", "Ah, a night owl. Watch {t} with me. Forever.", "{t}. {m} minutes in. The worst is yet to come. I mean the best.",
    ],
}

# a channel's own lines (mixed in when tuning in or between shows). day: daytime; night: evening and Horror Hours.
CHANNEL = {
    "fright": {"day": ["Fright Night in the daytime? You're braver than you look!", "Horror before lunch. I respect that.",
                       "Scary movies with the curtains open. Training wheels. I like it."],
               "night": ["Fright Night. My home channel. Wipe your feet.", "Welcome to Fright Night. Leave the lights on. It won't help.",
                         "This is where I live. Don't touch anything.", "Fright Night never sleeps. Neither will you."]},
    "sitcom": {"day": ["Sitcom Comfort! Laughs guaranteed, thinking optional.", "Ah, the comfort channel. Like soup, but funnier."],
               "night": ["Sitcoms at night. Even ghouls need a laugh.", "Laugh track's on. I like to think they're laughing at me."]},
    "action": {"day": ["Blockbuster! Things are about to explode. In a good way.", "Action time! Hold on to your popcorn."],
               "night": ["Explosions after dark. The neighbours will love it.", "Blockbuster. Loud, fast, and nobody reads the manual."]},
    "laughs": {"day": ["Laugh Track! Giggling is mandatory.", "Comedies all day. Your face muscles will thank me."],
               "night": ["A comedy? At this hour? How refreshing.", "Laugh now. Things get darker after midnight."]},
    "scifi": {"day": ["Deep Space! Next stop, the stars.", "Science fiction! Beep boop. That's robot for hello."],
              "night": ["Deep Space. In space, no one can hear you channel surf.", "Something's out there. It's on this channel."]},
    "after": {"day": ["After Dark in the daytime. Now that's a mystery.", "Thrillers! Keep an eye on the butler."],
              "night": ["After Dark. Everyone's a suspect. Even you.", "Thrillers, crime, mysteries. My kind of people."]},
    "toons": {"day": ["Saturday Morning! Cereal not included.", "Cartoons! The best part of any day."],
              "night": ["Cartoons at night? I won't tell anyone.", "Saturday Morning, any hour. Even this one."]},
    "family": {"day": ["Family Room! Something for everyone on the couch.", "Gather round! Grandma's saving you a seat."],
               "night": ["Family Room. Nice and safe. For now.", "A family film. How wholesome. I'll behave. Probably."]},
    "feels": {"day": ["The Big Feels. Tissues are on the coffee table.", "Get ready to feel things. Big things."],
              "night": ["The Big Feels. Even I cry at this one. Green tears.", "Love stories after dark. How romantic. How doomed."]},
    "fresh": {"day": ["Just Added! Brand new to your library.", "Fresh off the shelf. Nobody's even rewound it."],
              "night": ["New arrivals. Still warm.", "Just Added. Fresh blood. I mean films."]},
    "classics": {"day": ["Golden Age! They don't make them like this anymore.", "Classics! Black and white and good all over."],
                 "night": ["Old films, old ghosts. We get along.", "The Golden Age. I remember it well. Too well."]},
    "70s": {"day": ["Rewind '70s! Flares are optional.", "The seventies! Groovy, baby."],
            "night": ["The seventies. Grainy, gritty, and gloriously grim.", "Rewind '70s. Shag carpet and bad decisions."]},
    "80s": {"day": ["Rewind '80s! Big hair, big synths, big fun.", "The eighties! Somebody find my leg warmers."],
            "night": ["The eighties after dark. Practical effects, practical screams.", "Rewind '80s. Totally tubular. Totally terrifying."]},
    "90s": {"day": ["Rewind '90s! Be kind, rewind.", "The nineties! Dial-up not included."],
            "night": ["The nineties at night. Remember video store horror covers?", "Rewind '90s. Your VCR is blinking 12:00."]},
    "00s": {"day": ["Y2K! The computers didn't crash, so here's a movie.", "The 2000s! Flip phones up."],
            "night": ["Y2K at night. Frosted tips and frosted nerves.", "The 2000s. Everything was on DVD and nothing was okay."]},
    "fantasy": {"day": ["Once Upon a Time! Dragons, wizards, and snacks.", "Fantasy! Grab your sword. Or a cushion."],
                "night": ["Once upon a time… something terrible happened. Stay tuned.", "Fantasy after dark. The forest is listening."]},
    "western": {"day": ["High Noon! Yeehaw, partner.", "Westerns! Dusty boots welcome."],
                "night": ["High Noon at midnight. The saloon never closes.", "This town ain't big enough for the two of us. Or is it?"]},
    "war": {"day": ["The Front Line. History, up close.", "War films and true battles. Helmets optional."],
            "night": ["The Front Line. Stay low.", "History after dark. The ghosts have stories."]},
    "music": {"day": ["Encore! Sing along, nobody's listening. Except me.", "Musicals and music films. Dance like no one's watching."],
              "night": ["Encore. I do a very good harmony. Haunting, really.", "Music after dark. Turn it up. Wake the neighbours."]},
    "drama": {"day": ["Prime Time! Big drama, small couch.", "Drama series! Clear your schedule."],
              "night": ["Prime Time. One more episode. You know you will.", "The drama never stops. Neither do I."]},
    "crime": {"day": ["Case Files! Put on your detective hat.", "Whodunit? Stay tuned and find out."],
              "night": ["Case Files after dark. The worst crimes happen now.", "Every case has a body. Let's go find it."]},
    "tvscifi": {"day": ["Beam Me Up! Strange new worlds, back to back.", "Sci-fi series! Set phasers to binge."],
                "night": ["Beam Me Up. Space is cold. Like me.", "The truth is out there. Somewhere on this channel."]},
    "anime": {"day": ["Anime! Grab your ramen.", "Anime time! Dramatic hair and dramatic feelings."],
              "night": ["Anime after dark. Some of these get very dark.", "One more episode. That's how it gets you."]},
    "kids": {"day": ["Kids Club! Grown-ups welcome too.", "Kids Club! Remember to sit back from the screen."],
             "night": ["Kids Club? Shouldn't somebody be in bed?", "Little ones asleep? Then this is all yours."]},
    "real": {"day": ["Real Stuff! True stories, real people.", "Documentaries! Learn something. I won't tell."],
             "night": ["Real Stuff. The scariest stories are true.", "True stories after dark. Truth is stranger than me."]},
}

TAKEOVER = {  # takeover days, said first: {mood: [lines]}
    "halloween": {"day": ["Happy Halloween! Costumes on, candy out, scary movies all day!", "Trick or treat! I'll take both.",
                          "Halloween! My favourite holiday. Obviously."],
                  "dusk": ["It's Halloween night. Every channel's a little haunted, but this one's possessed.",
                           "The trick-or-treaters are out. Don't open the door. Watch this instead.", "Halloween night. Jack-o'-lanterns lit. Doors locked."],
                  "evil": ["Halloween. The one night they let me out. Let's not waste it.", "Happy Halloween. Something followed you home.",
                           "It's Halloween, and the veil is thin. Hello from the other side."]},
    "krampus": {"day": ["Happy Krampusnacht! Be good today, okay?", "Krampusnacht! Shine your shoes and mind your manners."],
                "dusk": ["Krampusnacht. Somebody's checking the naughty list. Twice.", "Hear the bells? Those aren't sleigh bells."],
                "evil": ["Krampusnacht. Hear the chains? He's in the building.", "Krampus is coming. I hope you were good. I wasn't."]},
    "xmaseve": {"day": ["Merry Christmas Eve! Cocoa, blankets, and a few frights.", "Christmas Eve! Stockings up, scary movies on."],
                "dusk": ["Christmas Eve. Silent night? Not on this channel.", "'Twas the night before Christmas… and the screaming had begun."],
                "evil": ["Christmas Eve, and all through the house… something is stirring.", "He sees you when you're sleeping. So do I."]},
    "valentine": {"day": ["Happy Valentine's Day! Love is in the air. Mostly.", "Valentine's Day! Roses are red, and so is this channel."],
                  "dusk": ["Valentine's Day. Hearts, flowers, and a few that got broken. Literally.", "A romantic evening in. With horror."],
                  "evil": ["Be my Valentine. You don't really have a choice.", "I brought you a heart. Don't ask whose."]},
    "friday13": {"day": ["Friday the 13th! Knock on wood and stay out of the lake.", "Friday the 13th! Avoid ladders and black cats. Except me."],
                 "dusk": ["Friday the 13th. Stay out of the woods. And the cabin. And the lake.", "Unlucky day, lucky channel. Friday the 13th."],
                 "evil": ["Friday the 13th. He's back. He's always back.", "Ki ki ki… ma ma ma… Friday the 13th."]},
    "fullmoon": {"day": ["Full moon tonight! The wolves are out, but they're friendly. Probably.", "Full moon tonight! Brush your hair. All of it."],
                 "dusk": ["Full moon tonight. If you hear howling, that's just the TV. Hopefully.", "The moon's coming up big and round. Werewolves on the hour."],
                 "evil": ["Full moon. Check your hands. Hairy yet?", "Awoooo. Sorry. Full moon. Happens to the best of us."]},
}


# ---------- not repeating herself ----------
_recent, _lock = collections.OrderedDict(), threading.Lock()


def _pick(options, who, n=1):
    """n different lines she hasn't said to this person lately (falls back to anything once she's said them all)."""
    with _lock:
        seen = _recent.setdefault(who or "", collections.deque(maxlen=60))
        _recent.move_to_end(who or "")
        while len(_recent) > 500:
            _recent.popitem(last=False)
        fresh = [o for o in dict.fromkeys(options) if o not in seen]
        if len(fresh) < n:
            fresh = list(dict.fromkeys(options))
        out = random.sample(fresh, min(n, len(fresh)))
        seen.extend(out)
    return out


def _title(p):
    return p.get("show") or p.get("title") or "this one"


def _greetings(hour, weekday):
    m = mood(hour)
    lines = list(GREET[m])
    if m == "evil" and hour is not None and 1 <= hour < 4:
        lines += WITCHING * 2
    if weekday is not None and (weekday in (5, 6) or (weekday == 4 and hour is not None and hour >= 17)):
        lines += WEEKEND
    return m, lines


def greeting(hour, takeover=None, who=None, weekday=None):
    """What she says at the top of the guide: {name, mood, line, lines}; clients cycle through `lines`."""
    m, lines = _greetings(hour, weekday)
    out = _pick(lines, who, 6)
    if takeover in TAKEOVER:
        out = _pick(TAKEOVER[takeover][m], who, 1) + out[:4]
    return {"name": NAME, "mood": m, "line": out[0], "lines": out}


def _fresh(options, who):
    with _lock:
        seen = _recent.get(who or "", ())
        return [o for o in options if o not in seen]


def line(program, channel_name, hour, offset, takeover=None, who=None, channel_key=None):
    """What Vesper says when you tune in: an intro if the programme hasn't started (offset < 0), else a welcome. Now and
    then a line about the channel itself, or the takeover (only ones she hasn't said to this person lately)."""
    m = mood(hour)
    r = random.random()
    own = _fresh(CHANNEL.get(channel_key, {}).get("day" if m == "day" else "night", []), who)
    special = _fresh(TAKEOVER[takeover][m], who) if takeover in TAKEOVER else []
    if special and r < 0.35:
        text = _pick(special, who)[0]
    elif own and r < 0.6:
        text = _pick(own, who)[0]
    elif offset < 0:
        text = _pick(INTRO[m], who)[0].format(t=_title(program), ch=channel_name)
    else:
        text = _pick(JOIN[m], who)[0].format(t=_title(program), ch=channel_name, m=max(1, int(offset // 60)))
    return {"name": NAME, "mood": m, "line": text}
