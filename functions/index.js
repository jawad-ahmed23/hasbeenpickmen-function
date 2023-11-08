const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios").default;
const { API_SCORES_URL, ODDS_API_KEY } = require("./constants");

admin.initializeApp();

const MAX_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_DELAY = 1000;

const betsToCheck = async (bets) => {
  try {
    let totalPoints = 0;
    let _bets = [...bets];

    await Promise.all(
      bets.map(async (bet, i) => {
        const gameId = bet.gameId;

        if (bet.status === "in-progress") {
          let retryAttempts = 0;
          let backoffDelay = BASE_BACKOFF_DELAY;

          while (retryAttempts < MAX_RETRY_ATTEMPTS) {
            try {
              await new Promise((resolve) => setTimeout(resolve, backoffDelay));

              const res = await axios.get(
                `${API_SCORES_URL}/?apiKey=${ODDS_API_KEY}&eventIds=${gameId}&daysFrom=3`
              );

              const games = res.data;

              if (games) {
                const game = games[0];

                // games is completed!
                if (game && game?.completed) {
                  let homeScore = parseInt(game.scores[0].score);
                  let awayScore = parseInt(game.scores[1].score);

                  if (game.scores[0].name === bet.team) {
                    homeScore += bet.spread;
                  } else if (game.scores[1].name === bet.team) {
                    awayScore += bet.spread;
                  }

                  const totalGameScore =
                    parseInt(game.scores[0].score) +
                    parseInt(game.scores[1].score);

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
                      totalPoints += 0;
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

                    if (bet.total === totalGameScore) {
                      // winner = bet.team;
                      totalPoints += 0;
                    }
                  }

                  _bets[i] = {
                    ...bet,
                    status: winner === bet.team ? "win" : "lost",
                    gainedPoints: totalGameScore,
                  };
                }
              }

              break; // Break out of the retry loop if the request is successful
            } catch (error) {
              if (error.response && error.response.status === 429) {
                // Retry the request with exponential backoff
                retryAttempts++;
                backoffDelay *= 2;
              } else {
                throw error; // Throw the error if it's not a 429 error
              }
            }
          }

          // const res = await axios.get(
          //   `${API_SCORES_URL}/?apiKey=${ODDS_API_KEY}&eventIds=${gameId}&daysFrom=3`
          // );

          // const games = res.data;

          // if (games) {
          //   const game = games[0];

          //   // games is completed!
          //   if (game && game?.completed) {
          //     let homeScore = parseInt(game.scores[0].score);
          //     let awayScore = parseInt(game.scores[1].score);

          //     if (game.scores[0].name === bet.team) {
          //       homeScore += bet.spread;
          //     } else if (game.scores[1].name === bet.team) {
          //       awayScore += bet.spread;
          //     }

          //     const totalGameScore =
          //       parseInt(game.scores[0].score) + parseInt(game.scores[1].score);

          //     let isTie = false;
          //     let winner = "";

          //     if (bet.type === "Spread") {
          //       if (homeScore > awayScore) {
          //         winner = game.home_team;
          //       } else if (homeScore < awayScore) {
          //         winner = game.away_team;
          //       } else {
          //         isTie = "It's a tie!";
          //       }

          //       if (winner === bet.team) {
          //         totalPoints += 1;
          //       }
          //       if (isTie) {
          //         totalPoints += 0;
          //       }
          //     }

          //     if (bet.type === "totals") {
          //       if (bet.totals === "Over" && totalGameScore > +bet.point) {
          //         winner = bet.team;
          //         totalPoints += 1;
          //       }

          //       if (bet.totals === "Under" && totalGameScore < +bet.point) {
          //         winner = bet.team;
          //         totalPoints += 1;
          //       }

          //       if (bet.total === totalGameScore) {
          //         winner = bet.team;
          //         totalPoints += 0;
          //       }
          //     }

          //     _bets[i] = {
          //       ...bet,
          //       status: winner === bet.team ? "win" : "lost",
          //       gainedPoints: totalGameScore,
          //     };
          //   }
          // }
        }
      })
    );

    const isAllWin = _bets.every((bet) => bet.status === "win");

    return {
      totalPoints: isAllWin ? totalPoints + 1 : totalPoints,
      bets: _bets,
    };
  } catch (error) {
    console.log("BETS_CHECK_ERROR", error.message);
    return {};
  }
};

// Function to be scheduled
exports.checkBetsScheduled = functions.pubsub
  // this is running function on Tue,Wed,Sat,Sun every 50 mins
  .schedule("*/50 * * * 2,3,6,0")
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

          // const weeks = Object.keys(bet.bets).sort();

          let betsWeeksNo = Object.keys(bet.bets).map(
            (w) => +w.replace("week-", "")
          );

          betsWeeksNo = betsWeeksNo.sort((a, b) => a - b);

          // // latest week bets
          const currentWeek = betsWeeksNo[betsWeeksNo.length - 1];

          const currentWeekBets = bet.bets["week-" + String(currentWeek)];

          const isUncheckedBets = currentWeekBets.some(
            (bet) => bet.status === "in-progress"
          );

          if (isUncheckedBets && currentUserData) {
            const { totalPoints, bets: updatedBets } = await betsToCheck(
              currentWeekBets
              // userId,
              // currentUserData.points ? currentUserData.points : 0
            );

            if (totalPoints !== undefined) {
              // assign points
              await admin
                .firestore()
                .collection("users")
                .doc(userId)
                .update({
                  points: admin.firestore.FieldValue.increment(totalPoints),
                });
            }

            console.log("updatedBets -> " + currentUser.id, updatedBets);

            if (updatedBets !== undefined) {
              await admin
                .firestore()
                .collection("bets")
                .doc(userId)
                .update({
                  [`week-${currentWeek}`]: [...updatedBets],
                });
            }
          }
        })
      );
    } catch (error) {
      console.log(error);
    }
    return null; // Return null to indicate the function completed successfully
  });
