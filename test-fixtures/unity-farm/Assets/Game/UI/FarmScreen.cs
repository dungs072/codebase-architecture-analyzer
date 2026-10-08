using UnityEngine;
using VContainer;
using VContainer.Unity;
using Game.Farming;

namespace Game.UI
{
    public class FarmScreen : MonoBehaviour
    {
        [Inject] private FarmController _controller;
        [SerializeField] private UnityEngine.UI.Button plantButton;

        private void Awake() { plantButton.onClick.AddListener(OnPlantClicked); }

        private void OnPlantClicked() { _controller.Plant(0, "carrot"); }

        public void ShowGrowth(float g) { }
    }

    public class FarmController : IStartable
    {
        private readonly FarmManager _farm;

        public FarmController(FarmManager farm) { _farm = farm; }

        public void Start() { }

        public void Plant(int plot, string crop) { new PlantCropAction(_farm, plot, crop).Execute(); }

        public void Harvest(int plot) { new HarvestCropAction(_farm, plot).Execute(); }
    }
}
