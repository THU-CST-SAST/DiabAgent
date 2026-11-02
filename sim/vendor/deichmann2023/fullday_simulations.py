# **********************************************************************************************************************
#  Copyright © 2022 ETH Zurich, Julia Deichmann, Sara Bachmann, Marie-Anne Burckhardt, Marc Pfister, Gabor Szinnai,
#  Hans-Michael Kaltenbach; D-BSSE; CSB Group
#  All rights reserved. This program and the accompanying materials are made available under the terms of the BSD-3
#  Clause License which accompanies this distribution, and is available at
#  https://gitlab.com/csb.ethz/t1d-exercise-model/-/blob/main/LICENSE
# **********************************************************************************************************************

# This script is used to generate glucose data in full-day simulations using a model of glucose-insulin regulation
# including exercise, meal intake and insulin injections.
# It generates the data for Figure 4 of the following manuscript:
#
# Title:   New model of glucose-insulin regulation characterizes effects of physical activity and facilitates
#          personalized treatment evaluation in children and adults with type 1 diabetes
# Authors: Julia Deichmann, Sara Bachmann, Marie-Anne Burckhardt, Marc Pfister, Gabor Szinnai, Hans-Michael Kaltenbach*
# *Corresponding author:
#          michael.kaltenbach@bsse.ethz.ch
#
# Date:    March 17, 2022
# Author:  Julia Deichmann <julia.deichmann@bsse.ethz.ch>

import functions.PAmodel as GIM
import functions.plot_fct as plot
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


''' Define basal values '''

Gb = 120                                    # basal glucose level [mg/dl]
Ib = 12                                     # basal insulin level [muU/ml]
weight = 70                                 # weight [kg]


''' Define scenarios '''

intensity = [0, 2095, 4317, 6539]           # intensity in AC count (rest, 30%, 60%, 90% VO2max)
duration = [30, 60, 180]                    # PA duration [min]
pa_start = [240, 600]                       # timing of PA start [min]

t_meal = [60, 420, 780]                     # timing of meals [min]
D = [4e4, 6e4, 5e4]                         # CHO amount [mg]


''' Parameters '''

params = pd.read_csv('parameters/params_standard.csv', header=None,
                     dtype={0: str}, delimiter=';').set_index(0).squeeze().to_dict()


''' Define model input '''

t_sim = 1441                                # simulation duration [min]
t = np.arange(t_sim)                        # create time points

meal = np.zeros(t_sim)                      # define meal input [mg/min]
meal[t_meal] = D


''' Compute glucose profile '''

for i in range(len(pa_start)):
    for j in range(len(duration)):
        G = []
        for k in range(len(intensity)):
            if (j == 0) or (k in [0, 1, 2]):

                u = np.zeros(t_sim)         # define insulin input [muU/min]

                AC = np.zeros(t_sim)        # define AC input [counts/min]
                AC[pa_start[i]:pa_start[i]+duration[j]] = intensity[k]

                model = GIM.compute_glucose_simulation(params, [Gb, Ib], weight, AC, meal, u=u,
                                                       bolus_calc=True)
                G.append(model['G'])

        plot.plot_simulation(G, labels=['rest', '30%', '60%', '90%'],
                             colors=[plt.cm.PuBu(0.85)] + list(plt.cm.Reds(np.linspace(0.3, 0.9, 3))),
                             pa=[pa_start[i], pa_start[i]+duration[j]])
        plt.show()
