const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios").default;
const { API_SCORES_URL, ODDS_API_KEY } = require("./constants");

admin.initializeApp();

const betsToCheck = async (bets, userId, userCurrentPoints) => {
  try {
    let totalPoints = 0;
    let _bets = [...bets];

    await Promise.all(
      bets.map(async (bet, i) => {
        const gameId = bet.gameId;

        if (bet.status === "in-progress") {
          const res = await axios.get(
            `${API_SCORES_URL}/?apiKey=${ODDS_API_KEY}&eventIds=${gameId}&daysFrom=3`
          );

          const games = res.data;

          if (games) {
            const game = games[0];

            // games is completed!
            if (game && game?.completed) {
              const homeScore = parseInt(game.scores[0].score) + bet.spread;
              const awayScore = parseInt(game.scores[1].score) + bet.spread;
              const totalGameScore =
                parseInt(game.scores[0].score) + parseInt(game.scores[1].score);

              let isTie = false;
              let winner = "";

              if (bet.type === "Spread") {
                if (homeScore > awayScore) {
                  winner = game.home_team;
                } else if (homeScore < awayScore) {
                  winner = game.away_team;
                } else {
                  isTie = "It's a tie!";
                }

                if (winner === bet.team) {
                  totalPoints += 1;
                }
                if (isTie) {
                  totalPoints += 0.5;
                }
              }

              if (bet.type === "totals") {
                if (bet.totals === "Over" && totalGameScore > +bet.point) {
                  winner = bet.team;
                  totalPoints += 1;
                }

                if (bet.totals === "Under" && totalGameScore < +bet.point) {
                  winner = bet.team;
                  totalPoints += 1;
                }
              }

              _bets[i] = {
                ...bet,
                status: winner === bet.team ? "win" : "lost",
                gainedPoints: totalGameScore,
              };
            }
          }
        }
      })
    );

    return { totalPoints, bets: _bets };
  } catch (error) {
    console.log(error);
    return {};
  }
};

// Function to be scheduled
exports.checkBetsScheduled = functions.pubsub
  .schedule("*/30 * * * 6")
  .timeZone("America/Chicago")
  .onRun(async (context) => {
    try {
      // Query the "bets" collection for documents added in the last 30 minutes
      const betsCollection = await admin.firestore().collection("bets").get();

      const bets = betsCollection.docs.map((bet) => ({
        userId: bet.id,
        bets: {
          ...bet.data(),
        },
      }));

      if (bets.length === 0) {
        return null;
      }

      await Promise.all(
        bets.map(async (bet) => {
          const userId = bet.userId;

          const currentUser = await admin
            .firestore()
            .collection("users")
            .doc(userId)
            .get();

          const currentUserData = currentUser.data();

          const weeks = Object.keys(bet.bets);

          const lastWeek = weeks[weeks.length - 1];

          const currentWeekBets = bet.bets[lastWeek];

          const { totalPoints, bets: updatedBets } = await betsToCheck(
            currentWeekBets,
            userId,
            currentUserData.points ? currentUserData.points : 0
          );

          // assign points
          await admin
            .firestore()
            .collection("users")
            .doc(userId)
            .update({
              points: admin.firestore.FieldValue.increment(+totalPoints),
            });

          await admin
            .firestore()
            .collection("bets")
            .doc(userId)
            .update({
              [lastWeek]: [...updatedBets],
            });
        })
      );
    } catch (error) {
      console.log(error);
    }
    return null; // Return null to indicate the function completed successfully
  });
``;
