"""Lucy, Vesper's little sister, who drops in on Live TV now and then (host.py decides when).

Vesper is a ghoul who'd like to be terrifying; Lucy is pink bows, lollipops and relentless good cheer, and wins most of
their arguments without noticing. In Horror Hours she's still sweet, just nervous (art: web/host/lucy-scared*.png).

Each scene is a short back-and-forth: "V:" is Vesper, "L:" is Lucy. Intro scenes take {t} (the next title) and {ch}
(the channel); join scenes take {t} and {m} (minutes in).
"""

NAME = "Lucy"

SCENES = {
    "day": [
        ["L: Good afternoon, everyone! I brought muffins!", "V: She brought muffins. In daylight. Like an animal.",
         "L: They're blueberry, Vessie.", "V: …Save me the one with the most blueberries."],
        ["L: Vesper, say something nice to our viewers!", "V: …Your couch looks structurally sound.",
         "L: See? She's a big softie.", "V: I will haunt you."],
        ["V: Today's lineup is bright, cheerful and family friendly.", "L: Your voice cracked on 'cheerful'.",
         "V: It's a hard word. Too many vowels."],
        ["L: Did you know sunshine is good for you?", "V: Did you know I'm a ghoul?", "L: Agree to disagree!"],
        ["L: I put a bow on the remote so it's easier to find!", "V: It's pink. It sparkles. I can see it with my eyes closed.",
         "L: You're welcome!"],
        ["V: Lucy, why are you here?", "L: Mum says you need more friends.", "V: I have friends.",
         "L: The candle doesn't count.", "V: …Her name is Wendy, and she's a very good listener."],
        ["L: Vessie, smile for the people!", "V: I am smiling.", "L: Oh. Oh no. Okay, stop."],
        ["L: I alphabetised the channels!", "V: They're numbered.", "L: Alphabetically numbered!",
         "V: I'm going to go lie down in my coffin for a bit."],
        ["L: Snack report: gummy bears, gummy worms and gummy sharks.", "V: Any gummy eyeballs?",
         "L: Ew! …Side pocket."],
        ["V: Welcome to the daytime show.", "L: And hi from me! Lucy! Her favourite sister!", "V: Only sister.",
         "L: Still counts!"],
        ["L: Vessie, what's your favourite colour?", "V: Black.", "L: That's not a colour, that's a mood.",
         "V: Then my favourite mood is black."],
        ["L: I'm the morning person and she's the evening person!", "V: Together we're one exhausting person.",
         "L: Teamwork!"],
        ["V: Remember, viewers, the sun can't hurt you in here.", "L: It can't hurt you anywhere, Vessie. It's the sun.",
         "V: That's what it wants you to think."],
        ["L: I made you a friendship bracelet!", "V: It says 'BFF'.", "L: Best Fiend Forever! I asked what you'd like.",
         "V: …I'll wear it. Ironically."],
        ["L: What's your favourite thing about daytime?", "V: That it ends.", "L: Mine's that it starts!",
         "V: We're going to be here a while."],
        ["V: Kids, sit back from the screen.", "L: Aww, you care about their eyes!", "V: I care about my screen."],
    ],
    "dusk": [
        ["V: Good evening. The sun is setting.", "L: Bye, sun! See you tomorrow!", "V: Don't encourage it."],
        ["L: It's getting dark. Should I put the nightlight on?", "V: Lucy, I am what the nightlight is for."],
        ["V: Tonight's lineup has thrills, chills, and—", "L: Cuddles!", "V: No.", "L: A few cuddles.",
         "V: …One cuddle. In the second hour."],
        ["L: Why do you always carry a candle?", "V: Atmosphere.", "L: We have electricity.",
         "V: Electricity has no soul.", "L: Neither do you!", "V: Exactly. We understand each other."],
        ["L: I knitted you a scarf!", "V: It's pink.", "L: It's 'dusk rose'!", "V: …It is quite warm."],
        ["V: Lock the doors. Close the curtains.", "L: And make cocoa!", "V: That wasn't the next step.",
         "L: It is now!"],
        ["L: Vessie, what's your favourite kind of movie?", "V: Anything where the house wins.",
         "L: Mine's anything with a puppy.", "V: Then we agree on the most important rule.", "L: NOBODY HURTS THE DOG."],
        ["V: Ah, twilight. My favourite part of the day.", "L: Because it's pretty?", "V: Because it's almost night."],
        ["L: Should I be scared of the evening shows?", "V: Only a little.", "L: How little?", "V: Hold-my-hand little.",
         "L: Aww, you want to hold my hand!", "V: That's not what I— fine."],
        ["L: Our viewers look tired.", "V: They look perfect. Slightly hollow. Very ready.", "L: She means cozy!"],
        ["V: Remember, everybody: never go into the basement.", "L: But that's where the board games are!",
         "V: And that's how it gets you."],
        ["L: Can I pick tonight's movie?", "V: Is it the one with the singing horse again?",
         "L: His name is Biscuit and he deserves to be heard."],
        ["V: The shadows grow long…", "L: That's just my bow, Vessie. Sorry. I'll move."],
        ["L: Do vampires really not show up in mirrors?", "V: How should I know? I'm a ghoul.",
         "L: Is there a difference?", "V: Ghouls have standards."],
        ["L: I'm making popcorn. Butter or caramel?", "V: Grave dirt.", "L: Caramel it is!"],
        ["V: The night is young.", "L: Like me!", "V: Unfortunately."],
    ],
    "evil": [
        ["V: Welcome… to Horror Hours.", "L: Am I allowed to stay up for this?", "V: You're already up. That's the horror.",
         "L: Oh no."],
        ["L: Vessie, your eyes are doing the red thing again.", "V: It's the lighting.",
         "L: There is no lighting. It's three in the morning."],
        ["L: I heard a noise in the hallway.", "V: That's just the house settling.", "L: Settling what?", "V: Scores."],
        ["V: Somewhere out there, something is watching you right now.", "L: It's us, Vessie. We're the ones on TV.",
         "V: …Don't ruin it."],
        ["L: I brought a lollipop for courage.", "V: Does it work?", "L: No. But it's strawberry."],
        ["V: Tonight's movie has a twist.", "L: A happy twist?", "V: Someone's neck.", "L: VESPER."],
        ["L: Can we watch a cartoon instead?", "V: It's the middle of the night. The cartoons are asleep.",
         "L: Even the cartoons?", "V: Especially the cartoons. They need their strength."],
        ["V: Turn off the lights.", "L: Turn them on! Turn them on!", "V: Off.", "L: Halfway?", "V: …Halfway."],
        ["L: I'm not scared. I'm just holding my bow very tightly.", "V: That's what scared looks like, Lucy."],
        ["V: The witching hour approaches.", "L: Is it a nice witch?", "V: There are no nice witches.",
         "L: Aunt Hagatha's nice!", "V: Aunt Hagatha ate the postman.", "L: She said he was rude!"],
        ["L: If anything jumps out, I'm hiding behind you.", "V: Lucy. I'm the thing that jumps out.",
         "L: Then I'm hiding behind the couch."],
        ["V: Don't look behind you.", "L: Why?", "V: No reason.", "L: …Vessie, why?"],
        ["L: Okay, I'm going to bed. Goodnight, everyone!", "V: Sleep tight.", "L: Aww, thank you!",
         "V: Don't let anything bite.", "L: …Why would you add that part?"],
        ["V: Do you hear that scratching?", "L: That's me. I'm eating crisps very quietly.",
         "V: …Can you do it more menacingly?"],
        ["L: Vessie, will you protect me from the monsters?", "V: I am the monsters.", "L: So that's a yes!",
         "V: …That's a yes."],
        ["V: Every creak. Every whisper. Every shadow.", "L: Every snack?", "V: Fine. Every snack."],
        ["L: I checked under the bed. Nothing there!", "V: Did you check under the bed under the bed?",
         "L: …There's a second bed?"],
    ],
}

INTRO = {  # between shows
    "day": [
        ["V: Coming up on {ch}: {t}.", "L: Ooh, I love {t}!", "V: You've never seen it.", "L: I love it already!"],
        ["L: {t} is next! Will you watch with me?", "V: I'm working.", "L: You're sitting on the couch.",
         "V: It's a working couch."],
        ["V: Next, {t}.", "L: I'll get snacks!", "V: You always get snacks.", "L: And you always eat them!"],
        ["L: Everybody ready for {t}?", "V: They were born ready. Shortly after, they got comfy."],
    ],
    "dusk": [
        ["V: Next on {ch}: {t}.", "L: Is it scary?", "V: Wait and see.", "L: That means yes, doesn't it."],
        ["L: {t} is next! I made heart-shaped snacks.", "V: Real hearts?", "L: COOKIE hearts, Vessie."],
        ["V: Dim the lights for {t}.", "L: Not all the way though, right?", "V: …Not all the way."],
        ["L: What's {t} about?", "V: You'll find out in a minute.", "L: Can I find out now?", "V: No.",
         "L: How about now?"],
    ],
    "evil": [
        ["V: Up next: {t}. Nobody leaves.", "L: Can I leave?", "V: Nobody.", "L: …I'll get a blanket."],
        ["L: Is {t} the scary one?", "V: They're all the scary one, Lucy.", "L: Tell me when to close my eyes.",
         "V: Now.", "L: It hasn't started yet!", "V: Practice."],
        ["V: {t} is coming. It knows you're here.", "L: The movie knows?!", "V: Everything knows at this hour."],
        ["L: I'm watching {t} through my fingers.", "V: It hasn't started.", "L: I'm warming up."],
    ],
}

JOIN = {  # tuned in part-way
    "day": [
        ["L: Hi! You're just in time!", "V: They're {m} minutes late.", "L: Just in time to be late, then!"],
        ["V: You're {m} minutes into {t}.", "L: Don't worry, I'll catch you up!", "V: She won't.",
         "L: There was a person, and then a thing happened!", "V: See?"],
    ],
    "dusk": [
        ["V: {t}. You've missed {m} minutes.", "L: The good news is, I saved you a cookie.", "V: She ate the cookie.",
         "L: I saved you the memory of a cookie."],
        ["L: Shh, it's getting good!", "V: Lucy, you said that about the opening credits."],
    ],
    "evil": [
        ["V: You're late. They've already started screaming.", "L: Mostly that was me. Sorry."],
        ["L: Oh thank goodness, company!", "V: She's been hiding behind a cushion for {m} minutes.",
         "L: It's a very brave cushion."],
    ],
}

TAKEOVER = {
    "halloween": [
        ["L: Happy Halloween! I'm dressed as a ghost!", "V: That's a sheet with a bow on it.", "L: A FANCY ghost."],
        ["V: Halloween. My night.", "L: And mine! I'm a fairy princess.", "V: Terrifying.", "L: Thank you!"],
    ],
    "krampus": [
        ["L: Is Krampus real?", "V: He's my plus-one for the holiday party.", "L: Vessie, no."],
    ],
    "xmaseve": [
        ["L: I got you a present!", "V: Is it a coffin?", "L: It's socks.", "V: …Black ones?", "L: Pink!"],
        ["V: Christmas Eve. He sees you when you're sleeping.", "L: That's Santa, Vessie.", "V: Is it?"],
    ],
    "valentine": [
        ["L: Happy Valentine's, Vessie! I made you a card!", "V: 'Roses are red, violets are blue…'",
         "L: '…my sister is spooky, but I love her too!'", "V: …I'm keeping this. Don't tell anyone."],
    ],
    "friday13": [
        ["L: I'm avoiding black cats today.", "V: The cat is offended.", "L: Sorry, Mr. Whiskers!"],
    ],
    "fullmoon": [
        ["L: Full moon tonight! It's so pretty!", "V: That's what the werewolves say.", "L: The werewolves think I'm pretty?"],
    ],
}


def parse(scene, **fmt):
    """["V: hi", "L: hello"] -> [{"who": "vesper", "line": "hi"}, {"who": "lucy", "line": "hello"}]"""
    out = []
    for s in scene:
        who, _, text = s.partition(": ")
        out.append({"who": "lucy" if who == "L" else "vesper", "line": text.format(**fmt) if fmt else text})
    return out
