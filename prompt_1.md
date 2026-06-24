Important backend architecture to follow -
1. Players will use the time lock encryption to encrypt there locked price which will automatically get revealed after the end of the round.
2. Player must also have the option to keep the default pre signed action in the backed as well, to avoid the timer collapse.
3. The oracle will be pull based. The design should keep the oracle separate(modular) to be upgradable to any oracle(PYTH, switchboard, etc)
4. The numbers involved in the game must be configurable. This would help in tweaking the game and reaching the PFM as per users feedbacks.
5. For a player to join the game(room based or public match making), first step would be to take the deposit in the vault to make them eligible and prevent spam.
6. The game price feed Id and the betting token(Chips token) can be different.(i.e. Playing on BTC feed with USDC). The feed can be anything given oracle provides the data feed.(Can be stocks/commodity/crypto anything)
7. The players actions data is important. It provide spectators/observers to check on which feed price what is the amount they betted. Evaluate this, if this drives in the direction of game adoption. Add only if it makes the game better for other players or spectators.

